import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

export const API_PREFIX = 'api/v1';

/** Builds the Nest application without listening, so tests and main share the same setup. */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix(API_PREFIX);
  return app;
}
