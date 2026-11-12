import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { generateAfiliados, generateHogares } from './data.js';
import type { Provider } from './providers.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const openapiPath = (provider: Provider): string =>
  resolve(packageRoot, provider, 'openapi.yaml');

const ID_PATTERN = '^[0-9]{6,12}$';

/** Headers the gateway adds (ARCHITECTURE.md §6). Logged so the demo can show what arrived. */
const TRACE_HEADER = /^x-rid-|^x-request-id$/;
/** Never log these values in clear, even if the gateway forwards them. */
const MASKED_HEADERS = new Set(['x-rid-end-user', 'x-rid-data-subject']);

export function traceHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!TRACE_HEADER.test(name) || value === undefined) continue;
    result[name] = MASKED_HEADERS.has(name)
      ? '[masked]'
      : Array.isArray(value)
        ? value.join(', ')
        : value;
  }
  return result;
}

function problem(reply: FastifyReply, status: 400 | 404, title: string, detail?: string) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) });
}

export interface ServerOptions {
  /** Destination for logs (tests capture them); defaults to stdout. */
  logStream?: NodeJS.WritableStream;
}

export function buildServer(provider: Provider, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    // Fastify's request logs include the URL, which carries the identifier. Never log it
    // (ADR-0006, ADR-0009): only the trace headers below are logged.
    disableRequestLogging: true,
    // Fastify's default strips unknown fields silently; reject them as the OpenAPI contract says.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.setErrorHandler((error: { validation?: unknown; message: string }, _request, reply) => {
    if (error.validation) return problem(reply, 400, 'Solicitud inválida', error.message);
    app.log.error({ err: error.message }, 'unexpected error');
    return reply
      .code(500)
      .type('application/problem+json')
      .send({ type: 'about:blank', title: 'Error interno', status: 500 });
  });

  app.addHook('onRequest', (request, _reply, done) => {
    if (request.routeOptions.url !== '/health') {
      // routeOptions.url is the route template (/afiliados/:numeroIdentificacion), never the real path.
      request.log.info(
        {
          provider,
          method: request.method,
          route: request.routeOptions.url ?? 'unmatched',
          rid: traceHeaders(request.headers),
        },
        'request received',
      );
    }
    done();
  });

  app.get('/health', () => ({ status: 'ok', provider }));

  const spec = readFileSync(openapiPath(provider), 'utf8');
  app.get('/openapi.yaml', (_request, reply) => reply.type('application/yaml').send(spec));

  const idParams = {
    type: 'object',
    required: ['numeroIdentificacion'],
    properties: { numeroIdentificacion: { type: 'string', pattern: ID_PATTERN } },
  } as const;

  const afiliados = provider === 'salud' ? generateAfiliados() : undefined;
  const hogares = provider === 'salud' ? undefined : generateHogares();

  /** The provider's service. Served at the root and under /<provider>, like a node of the kit that
   * exposes each service under its own path (upstream servicePath, ARCHITECTURE.md §10). */
  const service = (scope: FastifyInstance, _options: unknown, done: () => void) => {
    if (afiliados) {
      scope.get<{ Params: { numeroIdentificacion: string } }>(
        '/afiliados/:numeroIdentificacion',
        { schema: { params: idParams } },
        (request, reply) => {
          const afiliado = afiliados.get(request.params.numeroIdentificacion);
          return afiliado ? afiliado : problem(reply, 404, 'No encontrado');
        },
      );

      scope.post<{ Body: { numeroIdentificacion: string } }>(
        '/afiliados/verificaciones',
        {
          schema: {
            body: {
              type: 'object',
              required: ['numeroIdentificacion'],
              additionalProperties: false,
              properties: { numeroIdentificacion: { type: 'string', pattern: ID_PATTERN } },
            },
          },
        },
        (request) => ({
          afiliadoActivo: afiliados.get(request.body.numeroIdentificacion)?.estado === 'activo',
        }),
      );
    } else if (hogares) {
      scope.get<{ Params: { numeroIdentificacion: string } }>(
        '/hogares/:numeroIdentificacion',
        { schema: { params: idParams } },
        (request, reply) => {
          const hogar = hogares.get(request.params.numeroIdentificacion);
          return hogar ? hogar : problem(reply, 404, 'No encontrado');
        },
      );
    }
    done();
  };
  void app.register(service);
  void app.register(service, { prefix: `/${provider}` });

  return app;
}
