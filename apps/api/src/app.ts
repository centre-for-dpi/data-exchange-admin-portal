import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { TOKEN_VERIFIER, type TokenVerifier } from './auth/token-verifier.js';
import { registerRateLimit } from './common/rate-limit.js';
import { METRICS_PATH, MetricsService, metricsTokenMatches } from './metrics/metrics.service.js';
import { AppModule } from './app.module.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from './common/problem.js';
import { instancePath, ProblemDetailsFilter } from './common/problem.filter.js';
import { documentMaxBytes, PDF_MIME } from './documents/documents.service.js';
import { PDF_UPLOAD_PATHS } from './documents/pdf-reply.js';
import { KIT_BUNDLE_MEDIA_TYPE } from '@den/contracts';
import { KIT_BUNDLE_UPLOAD_PATH } from './kit/kit-paths.js';
import { kitBundleMaxBytes } from './kit/kit-releases.service.js';
import { registerApiDocs } from './openapi/docs.js';
import {
  ingestTokenMatches,
  SUBJECT_ACCESS_BODY_LIMIT_BYTES,
  SUBJECT_ACCESS_PATH,
} from './transparency/subject-access.controller.js';
import { DenLogger, logFormat } from './common/logger.js';

export const API_PREFIX = 'api/v1';
/** Maximum JSON body (CLAUDE.md, ARCHITECTURE.md §12). Document uploads get their own limit. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** The portal's token verifier, set once the app exists (configureApp); none in bare adapters. */
let tokenVerifier: TokenVerifier | undefined;
/** The `sub` of a token the API accepts, or null: the rate limits' key (M6-01). */
const verifiedSubject = async (token: string): Promise<string | null> => {
  if (!tokenVerifier) return null;
  try {
    return (await tokenVerifier.verify(token)).sub;
  } catch {
    return null;
  }
};
const uploadTokenValid = async (token: string): Promise<boolean> =>
  !tokenVerifier || (await verifiedSubject(token)) !== null;

/**
 * Who may set X-Forwarded-For (DEN_TRUST_PROXY, M6-01): request.ip is then the caller's address,
 * for rate limits and security events. The proxy's addresses or networks, comma-separated
 * (`172.30.0.0/16`), so that another container that reaches the API directly cannot pick the
 * address it is logged and limited under. A number trusts that many hops whoever sends them:
 * only where nothing but the proxy reaches the API. Empty: nobody.
 */
export function trustedProxies(
  value: string | undefined,
): string | ((address: string, hop: number) => boolean) | false {
  const setting = value?.trim() ?? '';
  if (!setting || setting === '0') return false;
  if (/^\d+$/.test(setting)) {
    const hops = Number(setting);
    return (_address: string, hop: number) => hop < hops;
  }
  return setting;
}

export function createAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: trustedProxies(process.env.DEN_TRUST_PROXY),
  });
  // The API speaks JSON only: without this, text/plain bodies would reach handlers as strings.
  adapter.getInstance().removeContentTypeParser('text/plain');
  // Security headers on every answer (M6-01, ASVS V3/V4): nothing here is a page to frame or
  // sniff, nor to keep in a shared cache unless the endpoint says so (the network CA does). The
  // Scalar reference writes its own response (hijacked), outside these hooks.
  adapter.getInstance().addHook('onSend', (_request, reply, payload, done) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('referrer-policy', 'no-referrer');
    reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    done(null, payload);
  });
  // Documents (SPEC.md §3: PDF only) arrive as the raw body. Other routes get a Buffer that their
  // zod validation rejects, within the default 1 MiB limit.
  adapter
    .getInstance()
    .addContentTypeParser(PDF_MIME, { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  // The kit's bundle (P-03), for the operator's mirror: raw too, on its one upload route.
  adapter
    .getInstance()
    .addContentTypeParser(KIT_BUNDLE_MEDIA_TYPE, { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  // The transparency collector receives whole Fluent Bit chunks (internal, service token only).
  // Its larger body limit applies only once the token is checked: onRequest runs before the body
  // is read, so an unauthenticated caller gets 401 without the API buffering anything.
  adapter.getInstance().addHook('onRoute', (route) => {
    // Document uploads (PDF) and the kit's bundle: a larger limit, but only for callers that
    // present a token; the guard checks their roles after the body is read.
    const pdf = PDF_UPLOAD_PATHS.some((path) => route.url === `/${API_PREFIX}/${path}`);
    const bundle = route.url === `/${API_PREFIX}/${KIT_BUNDLE_UPLOAD_PATH}`;
    if ((pdf || bundle) && route.method === 'PUT') {
      route.bodyLimit = bundle ? kitBundleMaxBytes() : documentMaxBytes();
      const existing = route.onRequest ? [route.onRequest].flat() : [];
      route.onRequest = [
        ...existing,
        async (request, reply) => {
          // The token is verified here, before the body is read (M6-01): a made-up one does not
          // get to send megabytes. The guard checks the caller's roles after.
          const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
          if (token && (await uploadTokenValid(token))) return;
          const problem = toProblem({ statusCode: 401 }, instancePath(request.url));
          await reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problem);
        },
      ];
      return;
    }
    if (route.url !== `/${API_PREFIX}/${SUBJECT_ACCESS_PATH}`) return;
    route.bodyLimit = SUBJECT_ACCESS_BODY_LIMIT_BYTES;
    const existing = route.onRequest ? [route.onRequest].flat() : [];
    route.onRequest = [
      ...existing,
      async (request, reply) => {
        if (ingestTokenMatches(request.headers.authorization)) return;
        const problem = toProblem({ statusCode: 401 }, instancePath(request.url));
        await reply.code(401).type(PROBLEM_CONTENT_TYPE).send(problem);
      },
    ];
  });
  return adapter;
}

/**
 * Shared setup for the real app and for tests: prefix, RFC 9457 errors everywhere and docs.
 * The global filter must be set before init(): Nest installs Fastify's error and not-found
 * handlers during init and routes them through global filters, so errors raised before a
 * handler runs (malformed JSON, oversized body, wrong content type) become problems too.
 */
export async function configureApp(app: NestFastifyApplication): Promise<NestFastifyApplication> {
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ProblemDetailsFilter());
  registerMetrics(app);
  try {
    tokenVerifier = app.get<TokenVerifier>(TOKEN_VERIFIER, { strict: false });
  } catch {
    tokenVerifier = undefined;
  }
  await registerRateLimit(app, verifiedSubject);
  await app.init();
  registerApiDocs(app, API_PREFIX);
  return app;
}

/** Builds and initialises the application without listening. */
export async function createApp(module: Type = AppModule): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(module, createAdapter(), {
    // Masked lines, JSON with DEN_LOG_FORMAT=json (common/logger.ts).
    logger: new DenLogger(logFormat(), ['error', 'warn', 'log']),
  });
  return configureApp(app);
}

/**
 * Prometheus metrics (M5-06): every request's latency by route template, and GET /metrics,
 * outside the public prefix and only with DEN_METRICS_TOKEN (404 otherwise). Before init():
 * Fastify takes no hooks or routes once it is ready.
 */
function registerMetrics(app: NestFastifyApplication): void {
  let metrics: MetricsService;
  try {
    metrics = app.get(MetricsService, { strict: false });
  } catch {
    return;
  }
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onResponse', (request, reply, done) => {
    metrics.observe(
      request.method,
      request.routeOptions.url,
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
    done();
  });
  fastify.get(METRICS_PATH, async (request, reply) => {
    if (!metricsTokenMatches(request.headers.authorization)) {
      const problem = toProblem({ statusCode: 404 }, instancePath(request.url));
      return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problem);
    }
    return reply.type(metrics.contentType).send(await metrics.metrics());
  });
}
