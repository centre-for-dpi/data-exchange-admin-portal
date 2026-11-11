import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiReference } from '@scalar/nestjs-api-reference';
import type { ServerResponse } from 'node:http';
import { OpenApiService } from './openapi.service.js';

export const DOCS_PATH = '/api/docs';
export const OPENAPI_JSON_PATH = `${DOCS_PATH}/openapi.json`;

/**
 * Publishes the portal API's OpenAPI document and its Scalar reference (ADR-0013).
 * Must run after app.init() (routes discovered) and before the server starts listening.
 */
export function registerApiDocs(app: NestFastifyApplication, prefix: string): void {
  const openApi = app.get(OpenApiService);
  openApi.setGlobalPrefix(prefix);
  const document = openApi.document({ title: 'Portal RID API', version: '1' });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.get(OPENAPI_JSON_PATH, (_request, reply) => reply.send(document));

  const render = apiReference({ url: OPENAPI_JSON_PATH, withFastify: true }) as (
    request: unknown,
    response: ServerResponse,
  ) => void;
  fastify.get(DOCS_PATH, (request, reply) => {
    void reply.hijack();
    render(request, reply.raw);
  });
}
