import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { withRequestIp } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

/**
 * The audit log records the caller's address (SPEC.md §3, M-27): request.ip, which follows
 * X-Forwarded-For only when the peer is in DEN_TRUST_PROXY (the proxy, and the web that forwards
 * the visitor's address). Background jobs record none.
 */
describe('audit events carry the caller address (M-27)', () => {
  const saved = process.env.DEN_TRUST_PROXY;
  const prisma = new PrismaService();
  let issuer: TestIssuer;
  let trusting: NestFastifyApplication;
  let distrusting: NestFastifyApplication;

  beforeAll(async () => {
    issuer = await createTestIssuer();
    // Fastify's inject comes from 127.0.0.1: here, the web in front of the API.
    process.env.DEN_TRUST_PROXY = '127.0.0.1';
    trusting = await createTestApp(issuer);
    delete process.env.DEN_TRUST_PROXY;
    distrusting = await createTestApp(issuer);
  });
  afterAll(async () => {
    await trusting.close();
    await distrusting.close();
    await prisma.$disconnect();
    if (saved === undefined) delete process.env.DEN_TRUST_PROXY;
    else process.env.DEN_TRUST_PROXY = saved;
  });

  /** A first sign-in (user.registered) through `app`, and the address its event recorded. */
  async function registeredFrom(app: NestFastifyApplication): Promise<string | null> {
    const sub = randomUUID();
    const token = await issuer.token(sub, { email: `ip.${sub.slice(0, 8)}@example.org` });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(200);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'user.registered', actorId: sub },
    });
    return event.ip;
  }

  it("records the visitor's address forwarded by a trusted peer", async () => {
    expect(await registeredFrom(trusting)).toBe('203.0.113.9');
  });

  it("records the peer's own address when it is not trusted to forward", async () => {
    expect(await registeredFrom(distrusting)).toMatch(/127\.0\.0\.1$/);
  });

  it('records no address for the system, even inside a request', async () => {
    const audit = new AuditService();
    const id = randomUUID();
    await withRequestIp('198.51.100.1', () =>
      prisma.$transaction((tx) =>
        audit.record(tx, {
          actor: { type: 'system', id: 'test' },
          action: 'probe.created',
          target: { type: 'probe', id },
        }),
      ),
    );
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: id } });
    expect(event.ip).toBeNull();
  });
});
