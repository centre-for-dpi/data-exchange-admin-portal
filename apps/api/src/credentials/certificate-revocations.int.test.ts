import { createHash, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  certificateRevocationPreviewSchema,
  certificateRevocationResultSchema,
  createdApplicationSchema,
  issuedCertificateSchema,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCsr } from '../../test/csr.js';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { resolveNotification } from '../notifications/notification-rules.js';
import { NOTIFICATION_TOPIC } from '../notifications/notifying-actions.js';
import { OpaService } from '../opa/opa.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KEYCLOAK_ADMIN } from '../reconcilers/keycloak/keycloak-admin.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const keycloakStub = {
  findClient: () => Promise.resolve(undefined),
  createClient: () => Promise.resolve(),
  updateClient: () => Promise.resolve(),
};

/** SHA-256 (hex) of the first issuer of a chain: what the issuer filter takes. */
const issuerFingerprint = (chainPem: string) => {
  const pem = (chainPem.match(PEM_CERT) ?? [])[1] ?? '';
  return createHash('sha256')
    .update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'))
    .digest('hex');
};

/**
 * The operator's mass revocation of client certificates (M6-07), with certificates signed by the
 * real step-ca of the stack. Every case narrows to the certificates it issued (its entity, issued
 * since it started): the test database holds those of the other suites too.
 */
describe('mass revocation of client certificates (M6-07)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let programas = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [{ token: KEYCLOAK_ADMIN, value: keycloakStub }]);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (
    method: 'GET' | 'POST',
    url: string,
    who: string | null,
    payload?: unknown,
    acr?: string | null,
  ) =>
    app.inject({
      method,
      url: `/api/v1/admin/certificate-revocations${url}`,
      headers: who
        ? {
            authorization: `Bearer ${await issuer.token(subOf(who), acr === undefined ? {} : { acr })}`,
          }
        : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** Two applications of programas-sociales with a certificate each, issued now. */
  const issueTwo = async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const issued = [];
    for (let i = 0; i < 2; i += 1) {
      const headers = { authorization: `Bearer ${await issuer.token(subOf('carlos.dev'))}` };
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/entities/${programas}/applications`,
        headers,
        payload: {
          name: `Revocación ${randomUUID().slice(0, 6)}`,
          description: 'Consulta con certificado de cliente.',
          environment: 'sandbox',
          technicalContact: 'dev@programas.demo.den.example',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const application = createdApplicationSchema.parse(created.json()).application;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/entities/${programas}/applications/${application.id}/certificates`,
        headers,
        payload: { csr: await makeCsr(application.clientId) },
      });
      expect(res.statusCode, res.body).toBe(201);
      issued.push({ application, ...issuedCertificateSchema.parse(res.json()) });
    }
    return { since, issued };
  };
  const query = (filter: Record<string, string>) => `?${new URLSearchParams(filter).toString()}`;

  describe('authorization', () => {
    it('is for the platform admin only, with the second factor', async () => {
      expect((await call('GET', '/preview', 'pablo.plataforma')).statusCode).toBe(200);
      for (const who of ['ana.operadora', 'marta.regulador', 'sofia.auditora', 'carlos.dev']) {
        expect((await call('GET', '/preview', who)).statusCode, who).toBe(403);
        const body = { reason: 'Prueba de autorización', expectedCount: 1 };
        expect((await call('POST', '', who, body)).statusCode, who).toBe(403);
      }
      expect((await call('GET', '/preview', null)).statusCode).toBe(401);
      const withoutMfa = await call('GET', '/preview', 'pablo.plataforma', undefined, 'password');
      expect(withoutMfa.statusCode).toBe(403);
      expect(withoutMfa.json()).toMatchObject({ code: 'mfa_required' });
    });
  });

  it('previews by entity, issuance and issuer, then revokes exactly that set', async () => {
    const { since, issued } = await issueTwo();
    const intermediate = issuerFingerprint(issued[0]?.certificatePem ?? '');
    const scope = { entityId: programas, issuedFrom: since };

    const preview = certificateRevocationPreviewSchema.parse(
      (await call('GET', `/preview${query(scope)}`, 'pablo.plataforma')).json(),
    );
    expect(preview.count).toBe(2);
    expect(preview.entities).toEqual([
      expect.objectContaining({ id: programas, applications: 2, certificates: 2 }),
    ]);
    expect(preview.issuers).toEqual([
      expect.objectContaining({ fingerprint: intermediate, certificates: 2 }),
    ]);
    expect(preview.issuers[0]?.subject).not.toBe('');

    const count = async (filter: Record<string, string>) =>
      certificateRevocationPreviewSchema.parse(
        (await call('GET', `/preview${query(filter)}`, 'pablo.plataforma')).json(),
      ).count;
    expect(await count({ ...scope, issuer: intermediate })).toBe(2);
    expect(await count({ ...scope, issuer: 'a'.repeat(64) })).toBe(0);
    expect(await count({ ...scope, issuedTo: since })).toBe(0);

    // A count that is not the current one: nothing is revoked.
    const stale = await call('POST', '', 'pablo.plataforma', {
      ...scope,
      reason: 'Lote emitido con una librería vulnerable',
      expectedCount: 3,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await count(scope)).toBe(2);

    const executed = await call('POST', '', 'pablo.plataforma', {
      ...scope,
      reason: 'Lote emitido con una librería vulnerable',
      expectedCount: 2,
    });
    expect(executed.statusCode, executed.body).toBe(201);
    const result = certificateRevocationResultSchema.parse(executed.json());
    expect(result.revoked).toBe(2);
    expect(await count(scope)).toBe(0);

    const ids = issued.map((i) => i.credential.id);
    const rows = await prisma.credential.findMany({ where: { id: { in: ids } } });
    expect(rows.map((r) => r.status)).toEqual(['revoked', 'revoked']);

    // Off the gateway's lists: the OPA data no longer has their fingerprints, and one sync is
    // queued for the whole set.
    const { data } = await app.get(OpaService).data();
    for (const i of issued) {
      expect(data.clients[i.application.clientId]?.certificates).toEqual([]);
    }
    expect(
      await prisma.outboxMessage.count({
        where: { topic: POLICY_SYNC_TOPIC, aggregate: `certificate_revocation:${result.id}` },
      }),
    ).toBe(1);

    // Audited one by one, with the revocation's id and reason, and as a whole.
    const events = await prisma.auditEvent.findMany({
      where: { action: 'credential.revoked', targetId: { in: ids } },
      orderBy: { seq: 'asc' },
    });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.after).toMatchObject({
        status: 'revoked',
        reason: 'Lote emitido con una librería vulnerable',
        revocationId: result.id,
      });
    }
    const summary = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'certificate_revocation.executed', targetId: result.id },
    });
    expect(summary.after).toMatchObject({ revoked: 2, entities: 1, filter: scope });

    // The applications' developers are told; a certificate an application revokes itself is not
    // news to it.
    const [first] = events;
    expect(
      await prisma.outboxMessage.count({
        where: { topic: NOTIFICATION_TOPIC, aggregate: `audit:${first?.seq}` },
      }),
    ).toBe(1);
    const carlos = await prisma.user.findFirstOrThrow({
      where: { keycloakSub: subOf('carlos.dev') },
    });
    const resolved = await resolveNotification(prisma, {
      action: 'credential.revoked',
      targetId: first?.targetId ?? '',
      after: first?.after,
    });
    expect(resolved).toMatchObject({
      kind: 'certificate_revoked',
      link: `/my-apps/${issued[0]?.application.id ?? ''}`,
    });
    expect(resolved?.recipients).toContain(carlos.id);
    expect(
      await resolveNotification(prisma, {
        action: 'credential.revoked',
        targetId: first?.targetId ?? '',
        after: { status: 'revoked' },
      }),
    ).toBeNull();
  });

  it('requires a reason and a count', async () => {
    const short = await call('POST', '', 'pablo.plataforma', { reason: 'corto', expectedCount: 1 });
    expect(short.statusCode).toBe(400);
    const none = await call('POST', '', 'pablo.plataforma', { reason: 'Motivo suficiente' });
    expect(none.statusCode).toBe(400);
    const badFilter = await call('GET', '/preview?issuer=xyz', 'pablo.plataforma');
    expect(badFilter.statusCode).toBe(400);
  });
});
