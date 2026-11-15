import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  applicationDetailSchema,
  CSR_ERRORS,
  createdApplicationSchema,
  issuedCertificateSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCsr } from '../../test/csr.js';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { ServiceUnavailableError } from '../common/errors.js';
import { resolveNotification } from '../notifications/notification-rules.js';
import { NOTIFICATION_TOPIC } from '../notifications/notifying-actions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KEYCLOAK_ADMIN } from '../reconcilers/keycloak/keycloak-admin.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { CertificateLifecycleService } from './certificate-lifecycle.service.js';
import { checkIssued, StepCaClient, stepCaSettings } from './step-ca.client.js';

const DAY = 24 * 60 * 60 * 1000;
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const certsOf = (pem: string) => (pem.match(PEM_CERT) ?? []).map((c) => new X509Certificate(c));

const keycloakStub = {
  findClient: () => Promise.resolve(undefined),
  createClient: () => Promise.resolve(),
  updateClient: () => Promise.resolve(),
};

/**
 * Client certificates signed by the real step-ca of the stack (pnpm infra:up locally; the
 * step-ca service in CI), through the portal's JWK provisioner (M3-01).
 */
describe('client certificates through step-ca (M3-01)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const lifecycle = loadCountryConfig({ code: 'co' }).lifecycle;
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let programas = '';
  let root = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [{ token: KEYCLOAK_ADMIN, value: keycloakStub }]);
    root = await new StepCaClient().rootCertificate();
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

  const newApp = async () => {
    const res = await call('POST', `/api/v1/entities/${programas}/applications`, 'carlos.dev', {
      name: `Certificados ${randomUUID().slice(0, 6)}`,
      description: 'Consulta con certificado de cliente.',
      environment: 'sandbox',
      technicalContact: 'dev@programas.demo.rid.example',
    });
    expect(res.statusCode, res.body).toBe(201);
    return createdApplicationSchema.parse(res.json()).application;
  };

  const certificatesUrl = (applicationId: string) =>
    `/api/v1/entities/${programas}/applications/${applicationId}/certificates`;
  const downloadUrl = (applicationId: string, credentialId: string) =>
    `/api/v1/entities/${programas}/applications/${applicationId}/credentials/${credentialId}/certificate`;

  const issue = async (applicationId: string, clientId: string) => {
    const res = await call('POST', certificatesUrl(applicationId), 'carlos.dev', {
      csr: await makeCsr(clientId),
    });
    expect(res.statusCode, res.body).toBe(201);
    return { res, issued: issuedCertificateSchema.parse(res.json()) };
  };

  it('signs the CSR: CN = client id, client authentication only, the configured validity', async () => {
    const application = await newApp();
    const { res, issued } = await issue(application.id, application.clientId);
    expect(res.headers['cache-control']).toBe('no-store');

    const chain = certsOf(issued.certificatePem);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    const leaf = chain[0] as X509Certificate;
    expect(leaf.subject).toBe(`CN=${application.clientId}`);
    expect(leaf.subjectAltName).toBe(`DNS:${application.clientId}`);
    expect(leaf.ca).toBe(false);
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    const days = (leaf.validToDate.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(lifecycle.certificateValidityDays - 1);
    expect(days).toBeLessThanOrEqual(lifecycle.certificateValidityDays + 1);
    expect(() =>
      checkIssued(
        chain.map((c) => c.toString()),
        root,
        { commonName: application.clientId },
      ),
    ).not.toThrow();

    const credential = issued.credential;
    expect(credential.kind).toBe('mtls_certificate');
    expect(credential.status).toBe('active');
    expect(credential.certificate).toMatchObject({
      // RFC 8705 x5t#S256, the value the gateway computes (S-3).
      fingerprint: createHash('sha256').update(leaf.raw).digest('base64url'),
      serial: leaf.serialNumber.toLowerCase(),
      subject: `CN=${application.clientId}`,
      notAfter: leaf.validToDate.toISOString(),
      expiringSoon: false,
    });

    const detail = applicationDetailSchema.parse(
      (
        await call(
          'GET',
          `/api/v1/entities/${programas}/applications/${application.id}`,
          'carlos.dev',
        )
      ).json(),
    );
    expect(detail.credentials.find((c) => c.id === credential.id)).toEqual(credential);
    expect(detail.credentials.find((c) => c.kind === 'client_secret')?.certificate).toBeNull();
  });

  it('audits the issuance with the public facts of the certificate, not the PEM', async () => {
    const application = await newApp();
    const { issued } = await issue(application.id, application.clientId);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: issued.credential.id, action: 'credential.created' },
    });
    expect(event.after).toMatchObject({
      applicationId: application.id,
      kind: 'mtls_certificate',
      fingerprint: issued.credential.certificate?.fingerprint,
      serial: issued.credential.certificate?.serial,
      subject: `CN=${application.clientId}`,
    });
    expect(JSON.stringify(event.after)).not.toContain('BEGIN CERTIFICATE');
  });

  it('serves the certificate chain as a PEM download', async () => {
    const application = await newApp();
    const { issued } = await issue(application.id, application.clientId);
    const res = await call('GET', downloadUrl(application.id, issued.credential.id), 'carlos.dev');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pem-certificate-chain');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${application.clientId}.pem"`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(issued.certificatePem);

    const secret = applicationDetailSchema
      .parse(
        (
          await call(
            'GET',
            `/api/v1/entities/${programas}/applications/${application.id}`,
            'carlos.dev',
          )
        ).json(),
      )
      .credentials.find((c) => c.kind === 'client_secret');
    expect(
      (await call('GET', downloadUrl(application.id, secret?.id ?? ''), 'carlos.dev')).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', downloadUrl(application.id, randomUUID()), 'carlos.dev')).statusCode,
    ).toBe(404);
  });

  it('keeps one active certificate per application', async () => {
    const application = await newApp();
    await issue(application.id, application.clientId);
    const again = await call('POST', certificatesUrl(application.id), 'carlos.dev', {
      csr: await makeCsr(application.clientId),
    });
    expect(again.statusCode).toBe(409);
    expect(
      await prisma.credential.count({
        where: { applicationId: application.id, kind: 'mtls_certificate' },
      }),
    ).toBe(1);
  });

  it('refuses a CSR for another subject, a weak key or a broken request, before the CA', async () => {
    const application = await newApp();
    const cases: Array<[string, string]> = [
      [await makeCsr('rid-app-someone-else'), CSR_ERRORS.subject],
      [await makeCsr(application.clientId, { key: 'RSA-1024' }), CSR_ERRORS.key],
      [await makeCsr(application.clientId, { tamper: true }), CSR_ERRORS.signature],
      ['not a csr', CSR_ERRORS.malformed],
    ];
    for (const [csr, message] of cases) {
      const res = await call('POST', certificatesUrl(application.id), 'carlos.dev', { csr });
      expect(res.statusCode, message).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'validation_failed',
        errors: [{ path: 'csr', message }],
      });
    }
    const tooLong = await call('POST', certificatesUrl(application.id), 'carlos.dev', {
      csr: 'A'.repeat(20_000),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(await prisma.credential.count({ where: { applicationId: application.id } })).toBe(1);
  });

  it('only an active application gets a certificate', async () => {
    const application = await newApp();
    await prisma.application.update({
      where: { id: application.id },
      data: { status: 'suspended' },
    });
    const res = await call('POST', certificatesUrl(application.id), 'carlos.dev', {
      csr: await makeCsr(application.clientId),
    });
    expect(res.statusCode).toBe(409);
  });

  describe('authorization', () => {
    it('the app developer issues; other members 403; other entities 404; platform reads', async () => {
      const application = await newApp();
      const { issued } = await issue(application.id, application.clientId);
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
      const csr = { csr: await makeCsr(application.clientId) };
      const post = certificatesUrl(application.id);
      const get = downloadUrl(application.id, issued.credential.id);
      expect((await call('POST', post, { sub }, csr)).statusCode).toBe(403);
      expect((await call('GET', get, { sub })).statusCode).toBe(200);
      for (const user of ['lucia.datos', 'pedro.publicador', 'ana.operadora']) {
        expect((await call('POST', post, user, csr)).statusCode, user).toBe(404);
        expect((await call('GET', get, user)).statusCode, user).toBe(404);
      }
      for (const user of ['pablo.plataforma', 'marta.regulador']) {
        expect((await call('GET', get, user)).statusCode, user).toBe(200);
        expect((await call('POST', post, user, csr)).statusCode, user).toBe(404);
      }
      // The application of another entity, under this entity's path.
      const foreign = await prisma.application.findFirst({
        where: { entityId: { not: programas }, status: 'active' },
      });
      if (foreign) {
        expect(
          (await call('POST', certificatesUrl(foreign.id), 'carlos.dev', csr)).statusCode,
        ).toBe(404);
      }
    });
  });

  describe('step-ca client', () => {
    it('pins the root by fingerprint, and refuses a wrong pin', async () => {
      const fingerprint = createHash('sha256').update(new X509Certificate(root).raw).digest('hex');
      const pinned = new StepCaClient({
        ...stepCaSettings(),
        trustOnFirstUse: false,
        rootFingerprint: fingerprint,
      });
      expect(await pinned.rootCertificate()).toBe(root);
      const wrong = new StepCaClient({
        ...stepCaSettings(),
        trustOnFirstUse: false,
        rootFingerprint: 'ab'.repeat(32),
      });
      await expect(wrong.rootCertificate()).rejects.toThrow();
      const none = new StepCaClient({ ...stepCaSettings(), trustOnFirstUse: false });
      await expect(none.rootCertificate()).rejects.toThrow(/RID_STEP_CA_ROOT/);
    });

    it('answers 503 when the CA is unreachable or the provisioner password is wrong', async () => {
      const csrPem = await makeCsr('rid-app-x');
      const request = { csrPem, commonName: 'rid-app-x', validityHours: 24 };
      const down = new StepCaClient({ ...stepCaSettings(), url: 'https://127.0.0.1:1' });
      await expect(down.sign(request)).rejects.toBeInstanceOf(ServiceUnavailableError);
      const badPassword = new StepCaClient({ ...stepCaSettings(), password: 'not-the-password' });
      await expect(badPassword.sign(request)).rejects.toBeInstanceOf(ServiceUnavailableError);
    });
  });

  describe('lifecycle', () => {
    const service = () => app.get(CertificateLifecycleService);

    it(`notifies the app developers ${lifecycle.certificateExpiryWarningDays} days before expiry, once`, async () => {
      const application = await newApp();
      const { issued } = await issue(application.id, application.clientId);
      const now = new Date();
      const notAfter = new Date(now.getTime() + (lifecycle.certificateExpiryWarningDays - 1) * DAY);
      await prisma.credential.update({ where: { id: issued.credential.id }, data: { notAfter } });

      const first = await service().queueExpiryNotices(now);
      expect(first).toContain(issued.credential.id);
      expect(await service().queueExpiryNotices(now)).not.toContain(issued.credential.id);

      const events = await prisma.auditEvent.findMany({
        where: { targetId: issued.credential.id, action: 'credential.expiry_notice_queued' },
      });
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(
        await prisma.outboxMessage.count({
          where: { topic: NOTIFICATION_TOPIC, aggregate: `audit:${event?.seq}` },
        }),
      ).toBe(1);
      const carlos = await prisma.user.findFirstOrThrow({
        where: { keycloakSub: subOf('carlos.dev') },
      });
      const resolved = await resolveNotification(prisma, {
        action: 'credential.expiry_notice_queued',
        targetId: issued.credential.id,
        after: event?.after,
      });
      expect(resolved).toMatchObject({
        kind: 'certificate_expiring',
        params: { application: application.name, date: notAfter.toISOString() },
        link: `/my-apps/${application.id}`,
      });
      expect(resolved?.recipients).toContain(carlos.id);

      const detail = applicationDetailSchema.parse(
        (
          await call(
            'GET',
            `/api/v1/entities/${programas}/applications/${application.id}`,
            'carlos.dev',
          )
        ).json(),
      );
      expect(
        detail.credentials.find((c) => c.id === issued.credential.id)?.certificate?.expiringSoon,
      ).toBe(true);
    });

    it('marks certificates past notAfter as expired, audited, once', async () => {
      const application = await newApp();
      const { issued } = await issue(application.id, application.clientId);
      const now = new Date();
      await prisma.credential.update({
        where: { id: issued.credential.id },
        data: { notAfter: new Date(now.getTime() - 1000) },
      });
      expect(await service().expireDue(now)).toContain(issued.credential.id);
      expect(await service().expireDue(now)).not.toContain(issued.credential.id);
      const credential = await prisma.credential.findUniqueOrThrow({
        where: { id: issued.credential.id },
      });
      expect(credential.status).toBe('expired');
      expect(
        await prisma.auditEvent.count({
          where: { targetId: issued.credential.id, action: 'credential.expired' },
        }),
      ).toBe(1);
      // With the old one expired, the application can get a new certificate.
      await issue(application.id, application.clientId);
    });
  });
});
