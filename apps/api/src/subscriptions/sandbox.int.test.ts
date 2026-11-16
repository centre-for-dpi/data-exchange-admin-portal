import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  apiDetailSchema,
  apiVersionDetailSchema,
  catalogDetailSchema,
  createdApplicationSchema,
  subscriptionDetailSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { KEYCLOAK_ADMIN } from '../reconcilers/keycloak/keycloak-admin.js';
import { OpaService } from '../opa/opa.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HttpApisixAdmin } from '../reconcilers/apisix/apisix-admin.js';
import { ApisixReconciler } from '../reconcilers/apisix/apisix.reconciler.js';
import { routeId, sandboxRouteId } from '../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

/**
 * Sandbox mode (M4-08): sandbox applications reach only a version's sandbox (synthetic data), and
 * with features.sandbox.autoApprove their requests are approved at once. Against PostgreSQL, the
 * OPA bundle data and the real APISIX (the sandbox route).
 */
describe('sandbox applications and the sandbox route (M4-08)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      {
        token: KEYCLOAK_ADMIN,
        value: {
          findClient: () => Promise.resolve(undefined),
          createClient: () => Promise.resolve(),
          updateClient: () => Promise.resolve(),
        },
      },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const request = async (method: 'GET' | 'POST', url: string, username: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(sub(username))}` },
      ...(payload ? { payload } : method === 'POST' ? { payload: {} } : {}),
    });

  /** A published version of salud, with or without a sandbox upstream. */
  async function published(sandbox: boolean) {
    const slug = `sandbox-${randomUUID().slice(0, 8)}`;
    const api = apiDetailSchema.parse(
      (
        await request('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
          slug,
          name: `Sandbox ${slug}`,
          summary: 'Consulta el estado de afiliación de una persona.',
          description: 'API de prueba del modo sandbox.',
          sector: 'salud',
          classification: 'personal',
          ownerContact: 'apis@salud.demo.rid.example',
        })
      ).json(),
    );
    const version = apiVersionDetailSchema.parse(
      (
        await request('POST', `/entities/${salud}/apis/${api.id}/versions`, 'pedro.publicador', {
          version: '1.0',
          openapi,
          upstream: { type: 'node', servicePath: '/salud' },
          ...(sandbox ? { sandboxUpstream: { type: 'node', servicePath: '/salud' } } : {}),
          exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
          allowedPurposes: ['eligibility_check'],
        })
      ).json(),
    );
    await prisma.apiVersion.updateMany({
      where: { id: version.id },
      data: { status: 'published', publishedAt: new Date() },
    });
    await prisma.api.updateMany({ where: { id: api.id }, data: { status: 'published' } });
    return { apiId: api.id, versionId: version.id };
  }

  async function application(environment: 'sandbox' | 'production') {
    const res = await request('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `App ${environment} ${randomUUID().slice(0, 6)}`,
      description: 'Aplicación de prueba del modo sandbox.',
      environment,
      technicalContact: 'dev@programas.demo.rid.example',
    });
    expect(res.statusCode, res.body).toBe(201);
    return createdApplicationSchema.parse(res.json()).application;
  }

  const ask = (applicationId: string, apiVersionId: string) =>
    request('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Probar la integración en el sandbox.',
      legalBasisText: 'Pruebas con datos sintéticos.',
      validityMonths: 3,
    });

  it('a sandbox request is approved at once by the system, and calls the sandbox', async () => {
    const { versionId } = await published(true);
    const sandboxApp = await application('sandbox');
    const res = await ask(sandboxApp.id, versionId);
    expect(res.statusCode, res.body).toBe(201);
    const detail = subscriptionDetailSchema.parse(res.json());
    expect(detail.status).toBe('approved');
    expect(detail.version.basePath).toMatch(/^\/sandbox\/salud\//);
    const audited = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: detail.id, action: 'subscription.approved' },
    });
    expect(audited.actorType).toBe('system');
    expect(audited.after).toMatchObject({ autoApproved: true, sandbox: true });

    // In the bundle the sandbox app is a sandbox client, subscribed to the sandbox route only.
    const { data } = await app.get(OpaService).data();
    const client = data.clients[sandboxApp.clientId];
    expect(client?.environment).toBe('sandbox');
    expect(client?.subscriptions.map((s) => s.route)).toEqual([sandboxRouteId(versionId)]);
    expect(data.routes[sandboxRouteId(versionId)]).toMatchObject({ sandbox: true });
    expect(data.routes[sandboxRouteId(versionId)]?.operations[0]?.pathRegex).toContain('/sandbox/');
  });

  it('a production request still waits for the provider; it never goes to the sandbox', async () => {
    const { versionId } = await published(true);
    const production = await application('production');
    const res = await ask(production.id, versionId);
    const detail = subscriptionDetailSchema.parse(res.json());
    expect(detail.status).toBe('pending_provider');
    expect(detail.version.basePath).not.toMatch(/^\/sandbox/);
  });

  it('a sandbox app cannot ask for a version without sandbox', async () => {
    const { versionId } = await published(false);
    const sandboxApp = await application('sandbox');
    const res = await ask(sandboxApp.id, versionId);
    expect(res.statusCode).toBe(400);
  });

  it('the gateway serves the sandbox under /sandbox, and the catalogue shows it', async () => {
    const { apiId, versionId } = await published(true);
    const reconciler = app.get(ApisixReconciler);
    await reconciler.reconcileVersion(versionId);
    const route = await admin.get('routes', sandboxRouteId(versionId));
    expect(route?.uri).toMatch(/^\/sandbox\/salud\/sandbox-[^/]+\/v1\/\*$/);
    expect(Object.keys(route?.plugins ?? {})).toEqual(
      expect.arrayContaining(['openid-connect', 'opa', 'limit-count']),
    );
    // No transparency register for synthetic data.
    expect(route?.plugins).not.toHaveProperty('tcp-logger');
    expect(await admin.get('routes', routeId(versionId))).toBeDefined();

    const catalog = catalogDetailSchema.parse(
      (await request('GET', `/catalog/apis/${apiId}`, 'carlos.dev')).json(),
    );
    expect(catalog.versions[0]?.sandboxUrl).toMatch(/\/sandbox\/salud\//);

    // Retired, both routes go.
    await prisma.apiVersion.updateMany({ where: { id: versionId }, data: { status: 'retired' } });
    await reconciler.reconcileVersion(versionId);
    expect(await admin.get('routes', sandboxRouteId(versionId))).toBeUndefined();
  });
});
