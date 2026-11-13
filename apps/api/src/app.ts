import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { ProblemDetailsFilter } from './common/problem.filter.js';
import { registerApiDocs } from './openapi/docs.js';
import {
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
  // The transparency collector receives whole Fluent Bit chunks (internal, service token only).
  adapter.getInstance().addHook('onRoute', (route) => {
    if (route.url === `/${API_PREFIX}/${SUBJECT_ACCESS_PATH}`) {
      route.bodyLimit = SUBJECT_ACCESS_BODY_LIMIT_BYTES;
    }
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
