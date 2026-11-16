import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { securityEvent } from './problem.filter.js';

describe('security events of refused requests (M6-01)', () => {
  const request = (principal?: { keycloakSub: string }) =>
    ({
      method: 'GET',
      url: '/api/v1/entities/0190d0c4-0000-7000-8000-000000000001/usage/provided?documento=1000000001',
      routeOptions: { url: '/api/v1/entities/:entityId/usage/provided' },
      id: 'req-1',
      ip: '10.0.0.7',
      headers: {
        authorization: 'Bearer eyJ.secret.token',
        'user-agent': 'curl/8.0',
      },
      body: { numero: '1000000001' },
      principal,
    }) as unknown as FastifyRequest;

  it('names who, from where, what and why', () => {
    const event = JSON.parse(
      securityEvent(request({ keycloakSub: 'sub-1' }), 403, 'forbidden'),
    ) as Record<string, unknown>;
    expect(event).toEqual({
      event: 'request_refused',
      status: 403,
      code: 'forbidden',
      method: 'GET',
      route: '/api/v1/entities/:entityId/usage/provided',
      path: '/api/v1/entities/0190d0c4-0000-7000-8000-000000000001/usage/provided',
      requestId: 'req-1',
      sub: 'sub-1',
      ip: '10.0.0.7',
      userAgent: 'curl/8.0',
    });
  });

  it('never carries the query string, the token or the body', () => {
    const text = securityEvent(request(), 401, 'unauthenticated');
    expect(text).not.toContain('1000000001');
    expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toMatchObject({ sub: null });
  });
});
