import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer } from '../../test/test-auth.js';

/**
 * The API's Prometheus metrics (ARCHITECTURE.md §9, M5-06), against PostgreSQL: GET /metrics
 * only with the token, the request latencies by route template and the gauges read at scrape.
 */
describe("the API's metrics endpoint (M5-06)", () => {
  const token = 'metrics-test-token-0123456789';
  let previous: string | undefined;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    previous = process.env.RID_METRICS_TOKEN;
    process.env.RID_METRICS_TOKEN = token;
    app = await createTestApp(await createTestIssuer());
  });
  afterAll(async () => {
    await app.close();
    if (previous === undefined) delete process.env.RID_METRICS_TOKEN;
    else process.env.RID_METRICS_TOKEN = previous;
  });

  it('is not there without the token, nor with another one', async () => {
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer otro' },
    });
    expect(wrong.statusCode).toBe(404);
    // Never under the public prefix.
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics' })).statusCode).toBe(404);
  });

  it('exposes request latencies by route template and the operating gauges', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/health' });
    await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/apis/0190d0c4-0000-7000-8000-000000000000',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.body;
    expect(text).toMatch(
      /rid_api_http_request_duration_seconds_count\{[^}]*route="\/api\/v1\/health"/,
    );
    // The template, never the id in the path.
    expect(text).toContain('route="/api/v1/catalog/apis/:apiId"');
    expect(text).not.toContain('0190d0c4-0000-7000-8000-000000000000');
    for (const gauge of [
      'rid_queue_jobs',
      'rid_sync_targets',
      'rid_opa_bundle_lag_seconds',
      'rid_nodes',
      'rid_certificate_soonest_expiry_seconds',
      'rid_api_process_cpu_seconds_total',
    ]) {
      expect(text, gauge).toContain(`# TYPE ${gauge}`);
    }
    expect(text).toMatch(/rid_sync_targets\{system="apisix",status="[a-z_]+"\} \d+/);
  });
});
