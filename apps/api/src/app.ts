import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { METRICS_PATH, MetricsService, metricsTokenMatches } from './metrics/metrics.service.js';
import { AppModule } from './app.module.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from './common/problem.js';
import { instancePath, ProblemDetailsFilter } from './common/problem.filter.js';
import { documentMaxBytes, PDF_MIME } from './documents/documents.service.js';
import { PDF_UPLOAD_PATHS } from './documents/pdf-reply.js';
import { registerApiDocs } from './openapi/docs.js';
import {
  ingestTokenMatches,
  SUBJECT_ACCESS_BODY_LIMIT_BYTES,
  SUBJECT_ACCESS_PATH,
} from './transparency/subject-access.controller.js';

export const API_PREFIX = 'api/v1';
/** Maximum JSON body (CLAUDE.md, ARCHITECTURE.md §12). Document uploads get their own limit. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

export function createAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({ bodyLimit: BODY_LIMIT_BYTES });
  // The API speaks JSON only: without this, text/plain bodies would reach handlers as strings.
  adapter.getInstance().removeContentTypeParser('text/plain');
  // Documents (SPEC.md §3: PDF only) arrive as the raw body. Other routes get a Buffer that their
  // zod validation rejects, within the default 1 MiB limit.
  adapter
    .getInstance()
    .addContentTypeParser(PDF_MIME, { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  // The transparency collector receives whole Fluent Bit chunks (internal, service token only).
  // Its larger body limit applies only once the token is checked: onRequest runs before the body
  // is read, so an unauthenticated caller gets 401 without the API buffering anything.
  adapter.getInstance().addHook('onRoute', (route) => {
    // Document uploads (PDF): a larger limit, but only for callers that present a token; the
    // guard verifies it after the body is read.
    const upload = PDF_UPLOAD_PATHS.some((path) => route.url === `/${API_PREFIX}/${path}`);
    if (upload && route.method === 'PUT') {
      route.bodyLimit = documentMaxBytes();
      const existing = route.onRequest ? [route.onRequest].flat() : [];
      route.onRequest = [
        ...existing,
        async (request, reply) => {
          if (/^Bearer \S+$/.test(request.headers.authorization ?? '')) return;
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
  await app.init();
  registerApiDocs(app, API_PREFIX);
  return app;
}

/** Builds and initialises the application without listening. */
export async function createApp(module: Type = AppModule): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(module, createAdapter(), {
    logger: ['error', 'warn', 'log'],
  });
  return configureApp(app);
}

/**
 * Prometheus metrics (M5-06): every request's latency by route template, and GET /metrics,
 * outside the public prefix and only with RID_METRICS_TOKEN (404 otherwise). Before init():
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
