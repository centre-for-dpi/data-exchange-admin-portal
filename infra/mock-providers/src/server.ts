import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { type AssertionResult, assertionVerifier } from './assertion.js';
import { generateAfiliados, generateHogares } from './data.js';
import type { Provider } from './providers.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const openapiPath = (provider: Provider): string =>
  resolve(packageRoot, provider, 'openapi.yaml');

const ID_PATTERN = '^[0-9]{6,12}$';

/** Headers the gateway adds (ARCHITECTURE.md §6). Logged so the demo can show what arrived. */
const TRACE_HEADER = /^x-den-|^x-request-id$/;
/** Never log these values in clear, even if the gateway forwards them. */
const MASKED_HEADERS = new Set(['x-den-end-user', 'x-den-data-subject', 'x-den-body-subject']);

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

function problem(reply: FastifyReply, status: 400 | 401 | 404, title: string, detail?: string) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) });
}

export interface ServerOptions {
  /** Destination for logs (tests capture them); defaults to stdout. */
  logStream?: NodeJS.WritableStream;
  /**
   * The gateway's signed assertion (ADR-0024, M6-10): verified on every call with the portal's
   * JWKS, its result logged (the demo reads it); with `required`, a call without a valid one is
   * refused (401), as a provider that demands it would.
   */
  assertion?: {
    jwksUrl: string;
    audience: string;
    /** The gateway's public URL (DEN_ASSERTION_ISSUER): the assertions' `iss`. */
    issuer?: string;
    required: boolean;
    fetchFn?: typeof fetch;
  };
}

/** The assertion settings from the environment (DEN_GATEWAY_JWKS_URL); undefined without it. */
export function assertionFromEnv(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
): ServerOptions['assertion'] {
  const jwksUrl = env.DEN_GATEWAY_JWKS_URL?.trim();
  if (!jwksUrl) return undefined;
  return {
    jwksUrl,
    audience: env.DEN_ASSERTION_AUDIENCE?.trim() || provider,
    ...(env.DEN_ASSERTION_ISSUER?.trim() ? { issuer: env.DEN_ASSERTION_ISSUER.trim() } : {}),
    required: env.DEN_ASSERTION_REQUIRED === 'true',
  };
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

  app.setErrorHandler(
    (error: { validation?: unknown; message: string; statusCode?: number }, _request, reply) => {
      if (error.validation) return problem(reply, 400, 'Solicitud inválida', error.message);
      // A body that is not JSON (Fastify's parser rejects it with a 4xx): the client's fault, a 400,
      // as the OpenAPI documents. Found by the contract test of M4-06.
      if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
        return problem(reply, 400, 'Solicitud inválida');
      }
      app.log.error({ err: error.message }, 'unexpected error');
      return reply
        .code(500)
        .type('application/problem+json')
        .send({ type: 'about:blank', title: 'Error interno', status: 500 });
    },
  );

  // The raw bytes of every body, whatever its content type: the assertion binds their SHA-256
  // (M6-10), and a body the verifier did not see could not be checked.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    (request as { rawBody?: Buffer }).rawBody = body as Buffer;
    done(null, body);
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length > 0 ? JSON.parse(body.toString('utf8')) : undefined);
    } catch {
      done(Object.assign(new Error('Body is not JSON'), { statusCode: 400 }), undefined);
    }
  });

  const checkAssertion = options.assertion ? assertionVerifier(options.assertion) : undefined;
  if (checkAssertion && options.assertion) {
    const { required } = options.assertion;
    app.addHook('preHandler', async (request, reply) => {
      const route = request.routeOptions.url;
      if (route === '/health' || route === '/openapi.yaml') return;
      const result: AssertionResult = await checkAssertion(request.headers['x-den-assertion'], {
        method: request.method,
        url: request.raw.url ?? '',
        body: (request as { rawBody?: Buffer }).rawBody,
      });
      request.log.info(
        { provider, den: { 'x-request-id': request.headers['x-request-id'] }, assertion: result },
        'gateway assertion',
      );
      if (required && result !== 'verified') {
        return problem(reply, 401, 'Aserción del gateway inválida', result);
      }
    });
  }

  app.addHook('onRequest', (request, _reply, done) => {
    if (request.routeOptions.url !== '/health') {
      // routeOptions.url is the route template (/afiliados/:numeroIdentificacion), never the real path.
      request.log.info(
        {
          provider,
          method: request.method,
          route: request.routeOptions.url ?? 'unmatched',
          den: traceHeaders(request.headers),
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
