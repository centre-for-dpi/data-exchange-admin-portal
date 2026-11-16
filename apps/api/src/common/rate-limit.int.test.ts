import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';

/**
 * Anti-automation of the portal API (M6-01, ASVS 2.4.1), with small limits for the test: a quota
 * per caller, a tighter one on expensive routes, nothing on the platform's internal endpoints,
 * and uploads refused before their body when the token is not a real one.
 */
describe('rate limits of the portal API (M6-01)', () => {
  const saved = {
    general: process.env.RID_RATE_LIMIT_PER_MINUTE,
    strict: process.env.RID_RATE_LIMIT_STRICT_PER_MINUTE,
  };
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    process.env.RID_RATE_LIMIT_PER_MINUTE = '5';
    process.env.RID_RATE_LIMIT_STRICT_PER_MINUTE = '2';
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await app.close();
    for (const [name, value] of [
      ['RID_RATE_LIMIT_PER_MINUTE', saved.general],
      ['RID_RATE_LIMIT_STRICT_PER_MINUTE', saved.strict],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('each caller has its own quota; past it, 429 in problem+json', async () => {
    const mine = { authorization: `Bearer ${await issuer.token(randomUUID())}` };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (await app.inject({ method: 'GET', url: '/api/v1/me', headers: mine })).statusCode,
      );
    }
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    const limited = await app.inject({ method: 'GET', url: '/api/v1/me', headers: mine });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(limited.headers['retry-after']).toBeDefined();

    // Someone else is not affected.
    const other = { authorization: `Bearer ${await issuer.token(randomUUID())}` };
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', headers: other })).statusCode,
    ).not.toBe(429);
  });

  it('expensive routes have a tighter quota of their own', async () => {
    const headers = { authorization: `Bearer ${await issuer.token(randomUUID())}` };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push(
        (await app.inject({ method: 'POST', url: '/api/v1/entity-requests', headers, payload: {} }))
          .statusCode,
      );
    }
    expect(statuses[0]).not.toBe(429);
    expect(statuses[2]).toBe(429);
  });

  it("the platform's internal endpoints and the health check are not limited", async () => {
    for (let i = 0; i < 8; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
      const internal = await app.inject({ method: 'GET', url: '/api/v1/opa/bundle.tar.gz' });
      expect(internal.statusCode).not.toBe(429);
    }
  });

  it('made-up tokens are not quotas of their own: they share their address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        remoteAddress: '10.1.0.1',
        headers: { authorization: `Bearer made-up-${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it("a node's enrollment is on the tight quota, by address (only its control routes are exempt)", async () => {
    const enroll = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/nodes/enroll',
        remoteAddress: '10.1.0.2',
        payload: {},
      });
    expect((await enroll()).statusCode).not.toBe(429);
    expect((await enroll()).statusCode).not.toBe(429);
    expect((await enroll()).statusCode).toBe(429);
  });

  it('an upload with a made-up token is refused before its body is read', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/entity-requests/${randomUUID()}/designation-document`,
      headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/pdf' },
      payload: Buffer.alloc(2 * 1024 * 1024, 0x25),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
