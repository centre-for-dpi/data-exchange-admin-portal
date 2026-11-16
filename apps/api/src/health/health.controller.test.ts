import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

describe('GET /api/v1/health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok without a database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('answers with the security headers, problems included (M6-01)', async () => {
    for (const url of ['/api/v1/health', '/api/v1/no-such-route']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['content-security-policy'], url).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(res.headers['strict-transport-security'], url).toContain('max-age=');
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
  });
});
