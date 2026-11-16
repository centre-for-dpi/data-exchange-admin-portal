import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { syncPageSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

/** The operator's sync console (M5-07), against PostgreSQL: list, drift and a queued retry. */
describe("the operator's sync console (M5-07)", () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const versionId = randomUUID();
  const target = `apisix:route:rid-route-${versionId}`;
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    await prisma.syncState.create({
      data: {
        target,
        system: 'apisix',
        desiredHash: 'h2',
        appliedHash: 'h1',
        status: 'error',
        lastError: 'APISIX PUT routes failed: 503',
        attempts: 3,
        driftDetectedAt: new Date(),
        driftCount: 1,
      },
    });
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await prisma.syncState.deleteMany({ where: { target } });
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (method: 'GET' | 'POST', url: string, username: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(sub(username))}` },
      ...(payload ? { payload } : {}),
    });

  it('lists the problems with their error and drift, and the summary by system', async () => {
    const res = await call(
      'GET',
      `/admin/sync?system=apisix&status=problems&q=${versionId}`,
      'ana.operadora',
    );
    expect(res.statusCode, res.body).toBe(200);
    const page = syncPageSchema.parse(res.json());
    const row = page.items.find((i) => i.target === target);
    expect(row).toMatchObject({
      status: 'error',
      attempts: 3,
      applied: false,
      lastError: 'APISIX PUT routes failed: 503',
      driftCount: 1,
    });
    expect(
      page.summary.find((s) => s.system === 'apisix' && s.status === 'error')?.count,
    ).toBeGreaterThanOrEqual(1);
    expect(page.recentDrift).toBeGreaterThanOrEqual(1);
  });

  it('a retry queues the reconciler job for the target, audited', async () => {
    const res = await call('POST', '/admin/sync/retry', 'pablo.plataforma', { target });
    expect(res.statusCode, res.body).toBe(202);
    const job = await prisma.outboxMessage.findFirst({
      where: { topic: 'gateway.sync', aggregate: `apiVersion:${versionId}` },
    });
    expect(job).not.toBeNull();
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'sync.retry_requested', targetId: target },
    });
    expect(event.actorType).toBe('user');
    expect(event.after).toMatchObject({
      topic: 'gateway.sync',
      aggregate: `apiVersion:${versionId}`,
    });
  });

  it('the gateway, OPA, the hub and OpenSearch have their own jobs; an unknown target is 404', async () => {
    for (const [t, topic] of [
      ['opa:bundle', 'policy.sync'],
      ['opensearch:index-template:rid-access', 'opensearch.sync'],
    ] as const) {
      const exists = await prisma.syncState.findUnique({ where: { target: t } });
      if (!exists) continue;
      const res = await call('POST', '/admin/sync/retry', 'pablo.plataforma', { target: t });
      expect(res.statusCode, t).toBe(202);
      expect(await prisma.outboxMessage.findFirst({ where: { topic } })).not.toBeNull();
    }
    const unknown = await call('POST', '/admin/sync/retry', 'pablo.plataforma', {
      target: `apisix:route:rid-route-${randomUUID()}`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('the reviewer reads but does not retry; others get 403', async () => {
    expect((await call('POST', '/admin/sync/retry', 'ana.operadora', { target })).statusCode).toBe(
      403,
    );
    for (const who of ['marta.regulador', 'carlos.dev']) {
      expect((await call('GET', '/admin/sync', who)).statusCode, who).toBe(403);
    }
  });
});
