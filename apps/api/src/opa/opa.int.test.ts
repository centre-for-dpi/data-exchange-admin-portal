import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { createdApplicationSchema, subscriptionDetailSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { untar } from '../../test/untar.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import type { BundleData } from './bundle.js';
import { seedScale } from '../load/scale-seed.js';
import { ACTIVATION_BATCH, OPA_SYNC_TARGET } from './opa.service.js';

const openapiFile = resolve(
  import.meta.dirname,
  '../../../../infra/mock-providers/salud/openapi.yaml',
);
const openapi = readFileSync(openapiFile, 'utf8');

describe('OPA bundle and activation (M1-09)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  const serviceToken = process.env.OPA_BUNDLE_TOKEN ?? '';
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';
  let versionId = '';
  let clientId = '';
  let approvedId = '';
  let pendingId = '';

  const call = async (method: 'GET' | 'POST', url: string, who: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(subOf(who))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const getBundle = (headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/opa/bundle.tar.gz',
      headers: { authorization: `Bearer ${serviceToken}`, ...headers },
    });

  const report = (revision: string, token = serviceToken) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/opa/status',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        labels: { id: 'opa-test', version: '1.21.4' },
        bundles: { rid: { name: 'rid', active_revision: revision } },
      },
    });

  const bundleData = async () => {
    const res = await getBundle();
    expect(res.statusCode, res.body).toBe(200);
    const entries = untar(res.rawPayload);
    return {
      etag: String(res.headers.etag),
      revision: (JSON.parse(entries.get('.manifest') ?? '{}') as { revision: string }).revision,
      data: JSON.parse(entries.get('data.json') ?? '{}') as BundleData,
    };
  };

  async function requestAccess(appId: string) {
    const res = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId: appId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar el subsidio X.',
      legalBasisText: 'Ley de protección de datos, artículo 10, literal b.',
      validityMonths: 12,
    });
    expect(res.statusCode, res.body).toBe(201);
    return subscriptionDetailSchema.parse(res.json()).id;
  }

  async function createApplication() {
    const res = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Validador ${randomUUID().slice(0, 6)}`,
      description: 'Valida requisitos al asignar subsidios.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.rid.example',
    });
    return createdApplicationSchema.parse(res.json()).application;
  }

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);

    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `opa-${run}`,
      name: `OPA ${run}`,
      summary: 'API para probar el bundle de OPA.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      tags: [],
      classification: 'personal',
      ownerContact: 'apis@salud.demo.rid.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const version = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: ['eligibility_check'],
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
      },
    );
    versionId = version.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {});

    const application = await createApplication();
    clientId = application.clientId;
    approvedId = await requestAccess(application.id);
    const approved = await call(
      'POST',
      `/entities/${salud}/access-requests/${approvedId}/approve`,
      'lucia.datos',
      { validityMonths: 6 },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    pendingId = await requestAccess((await createApplication()).id);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('bundle endpoint', () => {
    it('requires the service token, never a user token', async () => {
      const anonymous = await app.inject({ method: 'GET', url: '/api/v1/opa/bundle.tar.gz' });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['content-type']).toMatch(/problem\+json/);
      const user = await call('GET', '/opa/bundle.tar.gz', 'ana.operadora');
      expect(user.statusCode).toBe(401);
      expect((await getBundle({ authorization: 'Bearer wrong-token' })).statusCode).toBe(401);
    });

    it('carries routes, clients with granted subscriptions only, and the hash salt', async () => {
      const { data, etag, revision } = await bundleData();
      expect(etag).toBe(`"${revision}"`);
      expect(data.routes[`rid-route-${versionId}`]).toEqual({
        apiVersionId: versionId,
        classification: 'personal',
        operations: [
          {
            id: 'getAfiliado',
            method: 'GET',
            pathRegex: `^/salud/opa-${run}/v1/afiliados/[^/]+$`,
            // Where OPA finds the data subject (ADR-0015): the captured path segment, a cédula.
            subject: {
              in: 'path',
              regex: `^/salud/opa-${run}/v1/afiliados/([^/]+)$`,
              numberGroup: 1,
              documentType: 'CC',
            },
          },
          {
            id: 'verificarAfiliacion',
            method: 'POST',
            pathRegex: `^/salud/opa-${run}/v1/afiliados/verificaciones$`,
            subject: { in: 'body', documentType: 'CC' },
          },
        ],
      });
      const client = data.clients[clientId];
      expect(client).toMatchObject({ status: 'active', entitySlug: 'programas-sociales' });
      expect(client?.subscriptions).toEqual([
        expect.objectContaining({
          id: approvedId,
          route: `rid-route-${versionId}`,
          operations: ['getAfiliado'],
          purposes: ['eligibility_check'],
          endUserRequired: true,
          rateLimitPerMinute: 600,
        }),
      ]);
      // A request still waiting for the provider grants nothing.
      const all = Object.values(data.clients).flatMap((c) => c.subscriptions.map((s) => s.id));
      expect(all).not.toContain(pendingId);
      expect(data.config).toEqual({
        endUserHashSalt: process.env.RID_END_USER_HASH_SALT,
        subjectRefKey: process.env.RID_SUBJECT_REF_KEY,
        country: 'CO',
        documentTypes: ['CC', 'CE', 'TI', 'PEP', 'PPT', 'PA'],
        mtlsRequired: true,
        gatewayNodes: 1,
      });
    });

    it('answers 304 to the current ETag and records the revision', async () => {
      const { etag, revision } = await bundleData();
      const again = await getBundle({ 'if-none-match': etag });
      expect(again.statusCode).toBe(304);
      expect(again.rawPayload.length).toBe(0);
      const recorded = await prisma.policyBundle.findUnique({ where: { revision } });
      expect(recorded?.subscriptionIds).toContain(approvedId);
    });
  });

  describe('status report', () => {
    it('requires the service token', async () => {
      expect((await report('whatever', 'wrong-token')).statusCode).toBe(401);
    });

    it('activates the approved subscriptions of the revision OPA activated', async () => {
      const { revision } = await bundleData();
      // An unknown revision changes nothing.
      expect((await report('0'.repeat(64))).statusCode).toBe(204);
      expect(
        (await prisma.subscription.findUniqueOrThrow({ where: { id: approvedId } })).status,
      ).toBe('approved');

      expect((await report(revision)).statusCode).toBe(204);
      expect(
        (await prisma.subscription.findUniqueOrThrow({ where: { id: approvedId } })).status,
      ).toBe('active');
      expect(
        (await prisma.subscription.findUniqueOrThrow({ where: { id: pendingId } })).status,
      ).toBe('pending_provider');
      const events = await prisma.auditEvent.findMany({
        where: {
          targetType: 'subscription',
          targetId: approvedId,
          action: 'subscription.activated',
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: 'system', actorId: 'opa' });
      expect(
        await prisma.syncState.findUnique({ where: { target: OPA_SYNC_TARGET } }),
      ).toMatchObject({
        system: 'opa',
        appliedHash: revision,
      });

      // Reporting the same revision again is idempotent.
      await report(revision);
      expect(
        await prisma.auditEvent.count({
          where: { targetId: approvedId, action: 'subscription.activated' },
        }),
      ).toBe(1);

      // The consumer sees it active.
      const seen = await call(
        'GET',
        `/entities/${programas}/subscriptions/${approvedId}`,
        'carlos.dev',
      );
      expect(seen.json()).toMatchObject({ status: 'active' });
    });

    it('activates a backlog larger than one transaction, each with its audit event (M6-03)', async () => {
      // The load test's synthetic network, small: 4 entities x 10 APIs, 30 subscriptions each.
      await seedScale(prisma, new AuditService(), {
        entities: 4,
        apisPerEntity: 10,
        subscriptions: ACTIVATION_BATCH + 20,
        openapiFile,
        servicePath: '/salud',
      });
      const synthetic = { application: { keycloakClientId: { startsWith: 'rid-app-carga-' } } };
      // Each synthetic application has its client secret: the Keycloak reconciler needs it.
      expect(
        await prisma.application.count({
          where: {
            keycloakClientId: { startsWith: 'rid-app-carga-' },
            credentials: { none: { kind: 'client_secret', status: 'active' } },
          },
        }),
      ).toBe(0);
      // A backlog, as after an OPA outage: an earlier run of this test left them active.
      await prisma.subscription.updateMany({ where: synthetic, data: { status: 'approved' } });
      const ids = (
        await prisma.subscription.findMany({ where: synthetic, select: { id: true } })
      ).map((s) => s.id);
      expect(ids.length).toBeGreaterThan(ACTIVATION_BATCH);
      const activations = () =>
        prisma.auditEvent.count({
          where: { action: 'subscription.activated', targetId: { in: ids } },
        });
      const before = await activations();

      const { revision } = await bundleData();
      expect((await report(revision)).statusCode).toBe(204);
      expect(await prisma.subscription.count({ where: { ...synthetic, status: 'approved' } })).toBe(
        0,
      );
      expect(await activations()).toBe(before + ids.length);
    });
  });
});
