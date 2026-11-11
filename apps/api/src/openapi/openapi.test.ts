import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, createApp } from '../app.js';
import { OpenApiService } from './openapi.service.js';

describe('portal OpenAPI (ADR-0013)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('documents every route of the API', () => {
    const service = app.get(OpenApiService);
    service.setGlobalPrefix(API_PREFIX);
    const routes = service.routes();
    expect(routes.length).toBeGreaterThan(0);
    const undocumented = routes
      .filter((r) => !r.spec)
      .map((r) => `${r.method} ${r.path} (${r.handler})`);
    expect(undocumented).toEqual([]);
  });

  it('uses unique operationIds', () => {
    const ids = app
      .get(OpenApiService)
      .routes()
      .map((r) => r.spec?.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves an OpenAPI 3.1 document built from the zod schemas', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{
      openapi: string;
      paths: Record<
        string,
        Record<string, { operationId: string; responses: Record<string, unknown> }>
      >;
      components: { schemas: Record<string, unknown> };
    }>();
    expect(doc.openapi).toBe('3.1.0');
    const health = doc.paths['/api/v1/health']?.get;
    expect(health?.operationId).toBe('getHealth');
    expect(health?.responses['200']).toMatchObject({
      content: { 'application/json': { schema: { properties: { status: { const: 'ok' } } } } },
    });
    expect(health?.responses.default).toBeDefined();
    expect(doc.components.schemas.Problem).toMatchObject({ type: 'object' });
  });

  it('serves the Scalar API reference', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/api/docs/openapi.json');
  });
});
