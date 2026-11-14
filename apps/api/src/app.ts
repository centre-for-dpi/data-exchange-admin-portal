import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from './common/problem.js';
import { instancePath, ProblemDetailsFilter } from './common/problem.filter.js';
import { documentMaxBytes, PDF_MIME } from './documents/documents.service.js';
import { DESIGNATION_DOCUMENT_PATH } from './entities/entity-requests.controller.js';
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
    // Upload of a designation document: a larger limit, but only for callers that present a
    // token; the guard verifies it after the body is read.
    if (route.url === `/${API_PREFIX}/${DESIGNATION_DOCUMENT_PATH}` && route.method === 'PUT') {
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
