import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { applicationDetailSchema, createdApplicationSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { hashSecret } from '../common/secrets.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakeKeycloak } from '../../test/fake-keycloak.js';
import { KEYCLOAK_ADMIN } from '../reconcilers/keycloak/keycloak-admin.js';
import { KeycloakReconciler } from '../reconcilers/keycloak/keycloak.reconciler.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

describe('applications and OAuth2 credentials (M1-06)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const keycloak = new FakeKeycloak();
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let reconciler: KeycloakReconciler;
  let programas = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [{ token: KEYCLOAK_ADMIN, value: keycloak }]);
    reconciler = app.get(KeycloakReconciler);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (
    method: 'GET' | 'POST',
    url: string,
    who: string | { sub: string },
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await issuer.token(typeof who === 'string' ? subOf(who) : who.sub)}`,
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const body = (name = `Validador ${randomUUID().slice(0, 6)}`) => ({
    name,
    description: 'Valida requisitos al asignar subsidios.',
    environment: 'sandbox',
    technicalContact: 'dev@programas.demo.den.example',
  });

  const create = async () => {
    const res = await call(
      'POST',
      `/api/v1/entities/${programas}/applications`,
      'carlos.dev',
      body(),
    );
    expect(res.statusCode, res.body).toBe(201);
    return { res, created: createdApplicationSchema.parse(res.json()) };
  };

  it('creates the application and returns the client secret once, uncacheable', async () => {
    const { res, created } = await create();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(created.application.clientId).toBe(`den-app-${created.application.id}`);
    expect(created.application.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(created.application.provisioning).toBe('pending');
    // The gateway's token route (M3-10), not Keycloak itself.
    expect(created.application.tokenUrl).toMatch(/^https?:\/\/[^/]+(\/[^/]+)*\/oauth\/token$/);
    expect(created.clientSecret.length).toBeGreaterThanOrEqual(43);

    const again = await call(
      'GET',
      `/api/v1/entities/${programas}/applications/${created.application.id}`,
      'carlos.dev',
    );
    expect(again.body).not.toContain(created.clientSecret);
    expect(again.json()).not.toHaveProperty('clientSecret');
  });

  it('never stores the secret in clear: not in credentials, audit, outbox or the application', async () => {
    const { created } = await create();
    const secret = created.clientSecret;
    const credential = await prisma.credential.findFirstOrThrow({
      where: { applicationId: created.application.id },
    });
    expect(credential.secretHash).toBe(hashSecret(secret));
    expect(credential.sealedSecret).not.toBeNull();

    const leaks = await prisma.$queryRaw<Array<{ source: string }>>`
      SELECT 'credential' AS source FROM credential WHERE credential::text LIKE ${'%' + secret + '%'}
      UNION ALL SELECT 'audit_event' FROM audit_event WHERE audit_event::text LIKE ${'%' + secret + '%'}
      UNION ALL SELECT 'outbox' FROM outbox WHERE outbox::text LIKE ${'%' + secret + '%'}
      UNION ALL SELECT 'application' FROM application WHERE application::text LIKE ${'%' + secret + '%'}`;
    expect(leaks).toEqual([]);

    const actions = (
      await prisma.auditEvent.findMany({
        where: { targetId: { in: [created.application.id, credential.id] } },
        orderBy: { seq: 'asc' },
      })
    ).map((e) => e.action);
    expect(actions).toEqual(['application.created', 'credential.created']);
    expect(
      await prisma.outboxMessage.count({
        where: { topic: 'keycloak.sync', aggregate: `application:${created.application.id}` },
      }),
    ).toBe(1);
  });

  it('the reconciler creates the Keycloak client with that secret, then erases the sealed copy', async () => {
    const { created } = await create();
    const { id, clientId } = created.application;
    expect(await reconciler.reconcileApplication(id)).toBe('created');

    const client = keycloak.clients.get(clientId);
    expect(client).toMatchObject({
      enabled: true,
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      secret: created.clientSecret,
      attributes: { 'den.application': id, 'den.entity': programas, 'den.environment': 'sandbox' },
    });
    const credential = await prisma.credential.findFirstOrThrow({ where: { applicationId: id } });
    expect(credential.sealedSecret).toBeNull();
    expect(
      (
        await prisma.syncState.findUniqueOrThrow({
          where: { target: `keycloak:client:${clientId}` },
        })
      ).status,
    ).toBe('in_sync');

    const detail = applicationDetailSchema.parse(
      (await call('GET', `/api/v1/entities/${programas}/applications/${id}`, 'carlos.dev')).json(),
    );
    expect(detail.provisioning).toBe('ready');
  });

  it('is idempotent, repairs drift and disables suspended applications', async () => {
    const { created } = await create();
    const { id, clientId } = created.application;
    await reconciler.reconcileApplication(id);
    const before = { ...keycloak.calls };
    expect(await reconciler.reconcileApplication(id)).toBe('unchanged');
    expect(keycloak.calls).toEqual(before);

    // Someone edits the client by hand in Keycloak: the next pass restores the desired state.
    const drifted = keycloak.clients.get(clientId);
    if (drifted)
      keycloak.clients.set(clientId, {
        ...drifted,
        directAccessGrantsEnabled: true,
        name: 'tampered',
      });
    expect(await reconciler.reconcileApplication(id)).toBe('updated');
    expect(keycloak.clients.get(clientId)).toMatchObject({
      directAccessGrantsEnabled: false,
      secret: created.clientSecret,
    });

    await prisma.application.update({ where: { id }, data: { status: 'suspended' } });
    expect(await reconciler.reconcileApplication(id)).toBe('updated');
    expect(keycloak.clients.get(clientId)?.enabled).toBe(false);
  });

  it('reports an error when the client disappeared and its secret is no longer available', async () => {
    const { created } = await create();
    const { id, clientId } = created.application;
    await reconciler.reconcileApplication(id);
    keycloak.clients.delete(clientId);
    await expect(reconciler.reconcileApplication(id)).rejects.toThrow(/rotate the credential/);
    const state = await prisma.syncState.findUniqueOrThrow({
      where: { target: `keycloak:client:${clientId}` },
    });
    expect(state.status).toBe('error');
    const detail = (
      await call('GET', `/api/v1/entities/${programas}/applications/${id}`, 'carlos.dev')
    ).json<{ provisioning: string }>();
    expect(detail.provisioning).toBe('error');
  });

  describe('authorization', () => {
    it('only the app developer of the entity creates; other members 403, other entities 404', async () => {
      const sub = randomUUID();
      const viewer = await prisma.user.create({
        data: {
          keycloakSub: sub,
          email: `viewer.${sub.slice(0, 8)}@example.org`,
          fullName: 'Viewer',
          createdBy: 'system:test',
        },
      });
      await prisma.membership.create({
        data: {
          userId: viewer.id,
          entityId: programas,
          roles: ['entity_viewer'],
          status: 'active',
          createdBy: 'system:test',
        },
      });
      const url = `/api/v1/entities/${programas}/applications`;
      expect((await call('POST', url, { sub }, body())).statusCode).toBe(403);
      expect((await call('GET', url, { sub })).statusCode).toBe(200);
      for (const user of ['lucia.datos', 'pedro.publicador', 'ana.operadora']) {
        expect((await call('POST', url, user, body())).statusCode, user).toBe(404);
        expect((await call('GET', url, user)).statusCode, user).toBe(404);
      }
      for (const user of ['pablo.plataforma', 'marta.regulador']) {
        expect((await call('GET', url, user)).statusCode, user).toBe(200);
        expect((await call('POST', url, user, body())).statusCode, user).toBe(404);
      }
    });

    it('validates the input', async () => {
      const res = await call('POST', `/api/v1/entities/${programas}/applications`, 'carlos.dev', {
        ...body(),
        environment: 'staging',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
