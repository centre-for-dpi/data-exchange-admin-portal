import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  applicationDetailSchema,
  createdApplicationSchema,
  credentialSchema,
  issuedCertificateSchema,
  rotatedSecretSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCsr } from '../../test/csr.js';
import { FakeKeycloak } from '../../test/fake-keycloak.js';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { OpaService } from '../opa/opa.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KEYCLOAK_ADMIN } from '../reconcilers/keycloak/keycloak-admin.js';
import { KeycloakReconciler } from '../reconcilers/keycloak/keycloak.reconciler.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { CertificateLifecycleService } from './certificate-lifecycle.service.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Rotation and revocation of credentials (M3-04): secrets through the Keycloak reconciler (a fake
 * that behaves like Keycloak's rotation policy, checked for real in tests/infra) and certificates
 * signed by the real step-ca, through the OPA bundle.
 */
describe('credential rotation and revocation (M3-04)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const rotationDays = loadCountryConfig({ code: 'co' }).lifecycle.credentialRotationDays;
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

  const base = (applicationId: string) =>
    `/api/v1/entities/${programas}/applications/${applicationId}`;

  /** A new application whose client already exists in (fake) Keycloak with its first secret. */
  const newApp = async () => {
    const res = await call('POST', `/api/v1/entities/${programas}/applications`, 'carlos.dev', {
      name: `Rotación ${randomUUID().slice(0, 6)}`,
      description: 'Prueba la rotación de credenciales.',
      environment: 'sandbox',
      technicalContact: 'dev@programas.demo.rid.example',
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = createdApplicationSchema.parse(res.json());
    await reconciler.reconcileApplication(created.application.id);
    expect(keycloak.accepts(created.application.clientId, created.clientSecret)).toBe(true);
    return { ...created.application, secret: created.clientSecret };
  };

  const rotate = async (applicationId: string) => {
    const res = await call('POST', `${base(applicationId)}/credentials/secret`, 'carlos.dev');
    expect(res.statusCode, res.body).toBe(201);
    return { res, rotated: rotatedSecretSchema.parse(res.json()) };
  };

  const revoke = (applicationId: string, credentialId: string, who = 'carlos.dev') =>
    call('POST', `${base(applicationId)}/credentials/${credentialId}/revoke`, who, {
      reason: 'Fin de la migración',
    });

  describe('client secret', () => {
    it('issues a new secret once; the previous one keeps working during the window', async () => {
      const application = await newApp();
      const { res, rotated } = await rotate(application.id);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(rotated.credential.status).toBe('active');
      expect(rotated.previous.status).toBe('rotating');
      const window = new Date(rotated.previous.rotationEndsAt ?? 0).getTime() - Date.now();
      expect(window).toBeGreaterThan((rotationDays - 0.1) * DAY);
      expect(window).toBeLessThanOrEqual(rotationDays * DAY);
      expect(rotated.clientSecret).not.toBe(application.secret);

      // The reconciler: previous -> rotated secret, new -> current one.
      expect(await reconciler.reconcileApplication(application.id)).toBe('updated');
      expect(keycloak.accepts(application.clientId, rotated.clientSecret)).toBe(true);
      expect(keycloak.accepts(application.clientId, application.secret)).toBe(true);
      // Idempotent: nothing more to do, no second regeneration.
      const regenerations = keycloak.calls.regenerate;
      expect(await reconciler.reconcileApplication(application.id)).toBe('unchanged');
      expect(keycloak.calls.regenerate).toBe(regenerations);

      // The secret is shown once: the sealed copy is gone once Keycloak has it.
      const stored = await prisma.credential.findUniqueOrThrow({
        where: { id: rotated.credential.id },
      });
      expect(stored.sealedSecret).toBeNull();
      const detail = await call('GET', base(application.id), 'carlos.dev');
      expect(detail.body).not.toContain(rotated.clientSecret);

      const actions = (
        await prisma.auditEvent.findMany({
          where: { targetId: { in: [rotated.credential.id, rotated.previous.id] } },
          orderBy: { seq: 'asc' },
        })
      ).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining(['credential.rotation_started', 'credential.created']),
      );
    });

    it('one rotation at a time; the current secret cannot be revoked', async () => {
      const application = await newApp();
      const { rotated } = await rotate(application.id);
      expect(
        (await call('POST', `${base(application.id)}/credentials/secret`, 'carlos.dev')).statusCode,
      ).toBe(409);
      expect((await revoke(application.id, rotated.credential.id)).statusCode).toBe(409);
    });

    it('revoking the previous secret ends the window at once', async () => {
      const application = await newApp();
      const { rotated } = await rotate(application.id);
      await reconciler.reconcileApplication(application.id);
      const res = await revoke(application.id, rotated.previous.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(credentialSchema.parse(res.json()).status).toBe('revoked');
      expect(
        await prisma.outboxMessage.count({
          where: { topic: 'keycloak.sync', aggregate: `application:${application.id}` },
        }),
      ).toBeGreaterThanOrEqual(3);

      await reconciler.reconcileApplication(application.id);
      expect(keycloak.accepts(application.clientId, application.secret)).toBe(false);
      expect(keycloak.accepts(application.clientId, rotated.clientSecret)).toBe(true);
      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { targetId: rotated.previous.id, action: 'credential.revoked' },
      });
      expect(event.after).toMatchObject({ status: 'revoked', reason: 'Fin de la migración' });
      // Final: revoking again is an invalid transition, and a new rotation can start.
      expect((await revoke(application.id, rotated.previous.id)).statusCode).toBe(409);
      await rotate(application.id);
    });

    it('at the end of the window the previous secret expires and stops working', async () => {
      const application = await newApp();
      const { rotated } = await rotate(application.id);
      await reconciler.reconcileApplication(application.id);
      await prisma.credential.update({
        where: { id: rotated.previous.id },
        data: { rotationEndsAt: new Date(Date.now() - 1000) },
      });
      const ended = await app.get(CertificateLifecycleService).endRotations();
      expect(ended).toContain(rotated.previous.id);
      expect(await app.get(CertificateLifecycleService).endRotations()).not.toContain(
        rotated.previous.id,
      );
      expect(
        (await prisma.credential.findUniqueOrThrow({ where: { id: rotated.previous.id } })).status,
      ).toBe('expired');
      expect(
        await prisma.auditEvent.count({
          where: { targetId: rotated.previous.id, action: 'credential.rotation_ended' },
        }),
      ).toBe(1);
      await reconciler.reconcileApplication(application.id);
      expect(keycloak.accepts(application.clientId, application.secret)).toBe(false);
      expect(keycloak.accepts(application.clientId, rotated.clientSecret)).toBe(true);
    });

    it('finishes an interrupted rotation without losing the previous secret', async () => {
      const application = await newApp();
      const { rotated } = await rotate(application.id);
      // A pass that regenerated in Keycloak and stopped before setting the new secret.
      const client = await keycloak.findClient(application.clientId);
      await keycloak.regenerateSecret(client?.id ?? '');
      const regenerations = keycloak.calls.regenerate;
      await reconciler.reconcileApplication(application.id);
      expect(keycloak.calls.regenerate).toBe(regenerations);
      expect(keycloak.accepts(application.clientId, rotated.clientSecret)).toBe(true);
      expect(keycloak.accepts(application.clientId, application.secret)).toBe(true);
    });
  });

  describe('client certificate', () => {
    const issue = async (applicationId: string, clientId: string) => {
      const res = await call('POST', `${base(applicationId)}/certificates`, 'carlos.dev', {
        csr: await makeCsr(clientId),
      });
      expect(res.statusCode, res.body).toBe(201);
      return issuedCertificateSchema.parse(res.json()).credential;
    };
    const bundleCertificates = async (clientId: string) =>
      (await app.get(OpaService).data()).data.clients[clientId]?.certificates.sort() ?? [];

    it('a second certificate rotates the first; both work during the window, one rotation at a time', async () => {
      const application = await newApp();
      const first = await issue(application.id, application.clientId);
      const second = await issue(application.id, application.clientId);
      const detail = applicationDetailSchema.parse(
        (await call('GET', base(application.id), 'carlos.dev')).json(),
      );
      expect(detail.credentials.find((c) => c.id === first.id)).toMatchObject({
        status: 'rotating',
        rotationEndsAt: expect.any(String) as unknown,
      });
      expect(detail.credentials.find((c) => c.id === second.id)?.status).toBe('active');
      expect(await bundleCertificates(application.clientId)).toEqual(
        [first.certificate?.fingerprint, second.certificate?.fingerprint].sort(),
      );
      expect(
        (
          await call('POST', `${base(application.id)}/certificates`, 'carlos.dev', {
            csr: await makeCsr(application.clientId),
          })
        ).statusCode,
      ).toBe(409);

      // Past the window, the previous certificate leaves the bundle even before the job runs.
      await prisma.credential.update({
        where: { id: first.id },
        data: { rotationEndsAt: new Date(Date.now() - 1000) },
      });
      expect(await bundleCertificates(application.clientId)).toEqual([
        second.certificate?.fingerprint,
      ]);
    });

    it('revoking a certificate takes it out of the gateway at once', async () => {
      const application = await newApp();
      const first = await issue(application.id, application.clientId);
      const second = await issue(application.id, application.clientId);
      expect((await revoke(application.id, first.id)).statusCode).toBe(200);
      expect(await bundleCertificates(application.clientId)).toEqual([
        second.certificate?.fingerprint,
      ]);
      // The current certificate can be revoked too (compromised key): no certificate is left.
      expect((await revoke(application.id, second.id)).statusCode).toBe(200);
      expect(await bundleCertificates(application.clientId)).toEqual([]);
      expect(
        await prisma.outboxMessage.count({
          where: { topic: 'policy.sync', aggregate: `credential:${second.id}` },
        }),
      ).toBeGreaterThanOrEqual(2);
      // And a new one can be requested.
      await issue(application.id, application.clientId);
    });
  });

  describe('authorization', () => {
    it('the app developer rotates and revokes; other members 403; other entities 404', async () => {
      const application = await newApp();
      const { rotated } = await rotate(application.id);
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
      const secretUrl = `${base(application.id)}/credentials/secret`;
      expect((await call('POST', secretUrl, { sub })).statusCode).toBe(403);
      expect((await revoke(application.id, rotated.previous.id, '')).statusCode).toBe(401);
      for (const user of ['lucia.datos', 'pedro.publicador', 'ana.operadora']) {
        expect((await call('POST', secretUrl, user)).statusCode, user).toBe(404);
        expect((await revoke(application.id, rotated.previous.id, user)).statusCode, user).toBe(
          404,
        );
      }
      for (const user of ['pablo.plataforma', 'marta.regulador']) {
        expect((await revoke(application.id, rotated.previous.id, user)).statusCode, user).toBe(
          404,
        );
      }
      expect(
        (
          await call(
            'POST',
            `${base(application.id)}/credentials/${rotated.previous.id}/revoke`,
            { sub },
            {},
          )
        ).statusCode,
      ).toBe(403);
      expect((await revoke(application.id, randomUUID())).statusCode).toBe(404);
      expect(
        (
          await call(
            'POST',
            `${base(application.id)}/credentials/${rotated.previous.id}/revoke`,
            'carlos.dev',
            { reason: 'x'.repeat(600) },
          )
        ).statusCode,
      ).toBe(400);
    });
  });
});
