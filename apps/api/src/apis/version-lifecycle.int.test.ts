import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  apiVersionDetailSchema,
  createdApplicationSchema,
  subscriptionDetailSchema,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';
import { VersionLifecycleService } from './version-lifecycle.service.js';

const openapiText = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const DAY = 24 * 60 * 60 * 1000;

describe('API version lifecycle (M2-05, ADR-0019)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
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
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(subOf(who))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const versionBody = (version = '1.0') => ({
    version,
    openapi: openapiText,
    upstream: { type: 'node', servicePath: '/salud' },
    allowedPurposes: ['eligibility_check'],
    exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
  });

  /** A published personal-data API (no regulator step). */
  async function published() {
    const slug = `ciclo-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: `Ciclo ${slug}`,
      summary: 'API para probar el ciclo de vida de versiones.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@salud.demo.den.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const version = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      versionBody(),
    );
    const versionId = version.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    const approved = await call(
      'POST',
      `/review/api-versions/${versionId}/approve`,
      'ana.operadora',
      {},
    );
    expect(approved.statusCode, approved.body).toBe(200);
    return { apiId, versionId, url: `/entities/${salud}/apis/${apiId}/versions/${versionId}` };
  }

  /** carlos asks for access and lucia approves: a granted subscription on the version. */
  async function subscription(versionId: string, approve = true) {
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Ciclo ${randomUUID().slice(0, 6)}`,
      description: 'Aplicación de prueba del ciclo de vida.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.den.example',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const requested = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar un subsidio.',
      legalBasisText: 'Ley de protección de datos, artículo 10.',
      validityMonths: 12,
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const id = subscriptionDetailSchema.parse(requested.json()).id;
    if (approve) {
      const res = await call(
        'POST',
        `/entities/${salud}/access-requests/${id}/approve`,
        'lucia.datos',
        {},
      );
      expect(res.json()).toMatchObject({ status: 'approved' });
    }
    return id;
  }

  /** The published document plus a new optional operation (a compatible change). */
  const withNewOperation = () => {
    const doc = parse(openapiText) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const get = doc.paths['/afiliados/{numeroIdentificacion}']?.get ?? {};
    doc.paths['/afiliados/{numeroIdentificacion}/historial'] = {
      get: {
        ...structuredClone(get),
        operationId: 'getHistorialAfiliado',
        summary: 'Historial de afiliación',
      },
    };
    return JSON.stringify(doc);
  };
  const withoutOperation = () => {
    const doc = parse(openapiText) as { paths: Record<string, unknown> };
    delete doc.paths['/afiliados/verificaciones'];
    return JSON.stringify(doc);
  };

  const outboxFor = (versionId: string) =>
    prisma.outboxMessage.findMany({
      where: { aggregate: `apiVersion:${versionId}` },
      select: { topic: true, payload: true },
    });

  it('keeps one version per major: a second 1.x is refused, a new major is a draft', async () => {
    const { apiId } = await published();
    const minor = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      versionBody('1.1'),
    );
    expect(minor.statusCode).toBe(409);
    expect(minor.body).toContain('create major 2');
    const major = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      versionBody('2.0'),
    );
    expect(major.statusCode, major.body).toBe(201);
    const draft = apiVersionDetailSchema.parse(major.json());
    expect(draft.status).toBe('draft');
    expect(draft.basePath).toMatch(/\/v2$/);
  });

  it('revises a published version compatibly: next minor, same id, history and resync', async () => {
    const { versionId, url } = await published();
    const subscriptionId = await subscription(versionId);
    const before = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

    const res = await call('PUT', `${url}/openapi`, 'pedro.publicador', {
      openapi: withNewOperation(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const revised = apiVersionDetailSchema.parse(res.json());
    expect(revised).toMatchObject({ id: versionId, version: '1.1', status: 'published' });
    expect(revised.operations.map((o) => o.operationId)).toContain('getHistorialAfiliado');
    expect(revised.revisions).toEqual([expect.objectContaining({ version: '1.0' })]);

    const topics = (await outboxFor(versionId)).filter(
      (m) => (m.payload as { reason?: string }).reason === 'revised',
    );
    expect(topics.map((m) => m.topic).sort()).toEqual(
      [GATEWAY_SYNC_TOPIC, POLICY_SYNC_TOPIC].sort(),
    );
    const audit = await prisma.auditEvent.findMany({
      where: { targetId: versionId, action: 'api_version.revised' },
    });
    expect(audit).toHaveLength(1);
    // The new operation is not granted to the existing subscription.
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(after.approvedOperations).toEqual(before.approvedOperations);
    expect(after.approvedOperations).not.toContain('getHistorialAfiliado');
  });

  it('refuses incompatible revisions and unchanged documents', async () => {
    const { url } = await published();
    const breaking = await call('PUT', `${url}/openapi`, 'pedro.publicador', {
      openapi: withoutOperation(),
    });
    expect(breaking.statusCode).toBe(400);
    expect(breaking.body).toContain('needs a new major version');
    expect(breaking.body).toContain('POST /afiliados/verificaciones was removed');
    const same = await call('PUT', `${url}/openapi`, 'pedro.publicador', { openapi: openapiText });
    expect(same.statusCode).toBe(409);
  });

  it('deprecates with enough notice; then no new access requests are accepted', async () => {
    const { versionId, url } = await published();
    const days = loadCountryConfig({ code: 'co' }).lifecycle.apiRetirementNoticeDays;
    const early = await call('POST', `${url}/deprecate`, 'pedro.publicador', {
      sunsetAt: new Date(Date.now() + (days - 1) * DAY).toISOString(),
    });
    expect(early.statusCode).toBe(400);
    const sunsetAt = new Date(Date.now() + (days + 1) * DAY).toISOString();
    const res = await call('POST', `${url}/deprecate`, 'pedro.publicador', { sunsetAt });
    expect(res.statusCode, res.body).toBe(200);
    const detail = apiVersionDetailSchema.parse(res.json());
    expect(detail.status).toBe('deprecated');
    expect(detail.sunsetAt).toBe(sunsetAt);
    expect(
      (await outboxFor(versionId)).some(
        (m) =>
          m.topic === GATEWAY_SYNC_TOPIC &&
          (m.payload as { reason?: string }).reason === 'deprecated',
      ),
    ).toBe(true);
    // A deprecated version cannot be revised.
    expect(
      (await call('PUT', `${url}/openapi`, 'pedro.publicador', { openapi: withNewOperation() }))
        .statusCode,
    ).toBe(409);
    await expect(subscription(versionId)).rejects.toThrow();
  });

  it('only the provider’s publisher deprecates', async () => {
    const { url } = await published();
    const sunsetAt = new Date(Date.now() + 200 * DAY).toISOString();
    for (const who of ['lucia.datos', 'elena.admin']) {
      expect((await call('POST', `${url}/deprecate`, who, { sunsetAt })).statusCode).toBe(403);
    }
    expect((await call('POST', `${url}/deprecate`, 'ana.operadora', { sunsetAt })).statusCode).toBe(
      404,
    );
  });

  it('retires on the date: route removed, subscriptions revoked, requests rejected; idempotent', async () => {
    const { apiId, versionId, url } = await published();
    const granted = await subscription(versionId);
    const pending = await subscription(versionId, false);
    await call('POST', `${url}/deprecate`, 'pedro.publicador', {
      sunsetAt: new Date(Date.now() + 200 * DAY).toISOString(),
    });
    const lifecycle = app.get(VersionLifecycleService);
    expect(await lifecycle.retireDue()).not.toContain(versionId);

    await prisma.apiVersion.update({
      where: { id: versionId },
      data: { sunsetAt: new Date(Date.now() - 1000) },
    });
    expect(await lifecycle.retireDue()).toContain(versionId);
    const version = await prisma.apiVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.status).toBe('retired');
    expect(version.retiredAt).not.toBeNull();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: granted } })).status).toBe(
      'revoked',
    );
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: pending } })).status).toBe(
      'rejected',
    );
    expect((await prisma.api.findUniqueOrThrow({ where: { id: apiId } })).status).toBe('retired');
    const reasons = (await outboxFor(versionId)).filter(
      (m) => (m.payload as { reason?: string }).reason === 'retired',
    );
    expect(reasons.map((m) => m.topic).sort()).toEqual(
      [GATEWAY_SYNC_TOPIC, POLICY_SYNC_TOPIC].sort(),
    );
    const revoked = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: granted, action: 'subscription.revoked' },
    });
    expect(revoked).toMatchObject({
      actorType: 'system',
      after: { reason: 'api_version_retired' },
    });
    expect(
      await prisma.auditEvent.count({
        where: { targetId: versionId, action: 'api_version.retired' },
      }),
    ).toBe(1);

    expect(await lifecycle.retireDue()).not.toContain(versionId);
    // Once retired, the major is free again.
    const again = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      versionBody('1.5'),
    );
    expect(again.statusCode, again.body).toBe(201);
  });
});
