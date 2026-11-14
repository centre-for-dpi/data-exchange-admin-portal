import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  createdApplicationSchema,
  regulatorQueueSchema,
  reviewDetailSchema,
  subscriptionDetailSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

type Who = string | { sub: string };

describe('regulator approval (M2-04)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
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

  const call = async (method: 'GET' | 'POST', url: string, who: Who, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await issuer.token(typeof who === 'string' ? subOf(who) : who.sub)}`,
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** A sensitive version the operator approved: waiting in approved_operator. */
  async function waitingVersion() {
    const slug = `reg-${run}-${randomUUID().slice(0, 6)}`;
    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: `Historia clínica ${slug}`,
      summary: 'API sensible para probar al regulador.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'sensitive',
      ownerContact: 'apis@salud.demo.rid.example',
    });
    expect(api.statusCode, api.body).toBe(201);
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
        exposedFields: [{ name: 'diagnostico', personal: true, sensitive: true }],
      },
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
    expect(reviewDetailSchema.parse(approved.json()).version.status).toBe('approved_operator');
    return { apiId, versionId };
  }

  /** A published sensitive version and an access request the data steward approved. */
  async function waitingRequest() {
    const { versionId } = await waitingVersion();
    expect(
      (await call('POST', `/regulator/api-versions/${versionId}/approve`, 'marta.regulador', {}))
        .statusCode,
    ).toBe(200);
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Validador ${randomUUID().slice(0, 6)}`,
      description: 'Valida requisitos con datos de salud.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.rid.example',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const requested = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar una condición de salud para un subsidio.',
      legalBasisText: 'Ley de protección de datos, artículo 6.',
      validityMonths: 6,
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const id = subscriptionDetailSchema.parse(requested.json()).id;
    const approved = await call(
      'POST',
      `/entities/${salud}/access-requests/${id}/approve`,
      'lucia.datos',
      {
        validityMonths: 3,
      },
    );
    expect(approved.json()).toMatchObject({ status: 'pending_regulator' });
    return id;
  }

  const actions = async (targetId: string) =>
    (await prisma.auditEvent.findMany({ where: { targetId }, orderBy: { seq: 'asc' } })).map(
      (e) => e.action,
    );

  it('lists what waits for the regulator', async () => {
    const { versionId } = await waitingVersion();
    const subscriptionId = await waitingRequest();
    const res = await call('GET', '/regulator/approvals', 'marta.regulador');
    expect(res.statusCode).toBe(200);
    const queue = regulatorQueueSchema.parse(res.json());
    expect(queue.apiVersions.map((v) => v.versionId)).toContain(versionId);
    expect(
      queue.apiVersions.find((v) => v.versionId === versionId)?.operatorApprovedAt,
    ).not.toBeNull();
    expect(queue.subscriptions.find((s) => s.id === subscriptionId)).toMatchObject({
      provider: { id: salud },
      consumer: { id: programas },
    });
  });

  it('approving a sensitive version publishes it and enqueues the gateway route', async () => {
    const { versionId } = await waitingVersion();
    const res = await call(
      'POST',
      `/regulator/api-versions/${versionId}/approve`,
      'marta.regulador',
      {
        comment: 'Base legal suficiente.',
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const detail = reviewDetailSchema.parse(res.json());
    expect(detail.version.status).toBe('published');
    expect(detail.version.reviews.map((r) => [r.reviewerRole, r.decision])).toEqual([
      ['platform_reviewer', 'approved'],
      ['regulator', 'approved'],
    ]);
    expect(
      await prisma.outboxMessage.count({
        where: { topic: GATEWAY_SYNC_TOPIC, aggregate: `apiVersion:${versionId}` },
      }),
    ).toBe(1);
    expect(await actions(versionId)).toEqual(
      expect.arrayContaining(['api_version.approved_regulator', 'api_version.published']),
    );
    const again = await call(
      'POST',
      `/regulator/api-versions/${versionId}/approve`,
      'marta.regulador',
      {},
    );
    expect(again.statusCode).toBe(409);
  });

  it('sends a version back to the provider with a reason the provider reads', async () => {
    const { apiId, versionId } = await waitingVersion();
    const short = await call(
      'POST',
      `/regulator/api-versions/${versionId}/request-changes`,
      'marta.regulador',
      {
        comment: 'no',
      },
    );
    expect(short.statusCode).toBe(400);
    const res = await call(
      'POST',
      `/regulator/api-versions/${versionId}/request-changes`,
      'marta.regulador',
      {
        comment: 'Falta la base legal para el diagnóstico.',
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(reviewDetailSchema.parse(res.json()).version.status).toBe('changes_requested');
    const seen = await call(
      'GET',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}`,
      'pedro.publicador',
    );
    expect(seen.body).toContain('Falta la base legal para el diagnóstico.');
    expect(await actions(versionId)).toContain('api_version.changes_requested');
  });

  it('approving an access request keeps the granted validity and enqueues the policy sync', async () => {
    const id = await waitingRequest();
    const before = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    const res = await call('POST', `/regulator/subscriptions/${id}/approve`, 'marta.regulador', {});
    expect(res.statusCode, res.body).toBe(200);
    expect(subscriptionDetailSchema.parse(res.json()).status).toBe('approved');
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    expect(after.validUntil.getTime() - after.validFrom.getTime()).toBe(
      before.validUntil.getTime() - before.validFrom.getTime(),
    );
    expect(after.validFrom.getTime()).toBeGreaterThanOrEqual(before.validFrom.getTime());
    expect(
      await prisma.outboxMessage.count({
        where: { topic: POLICY_SYNC_TOPIC, aggregate: `subscription:${id}` },
      }),
    ).toBe(1);
    const decision = await prisma.subscriptionDecision.findFirstOrThrow({
      where: { subscriptionId: id, decidedByEntityId: null },
    });
    expect(decision.decision).toBe('approved');
    expect(await actions(id)).toContain('subscription.approved_regulator');
  });

  it('rejects an access request with a reason; it is final', async () => {
    const id = await waitingRequest();
    const res = await call('POST', `/regulator/subscriptions/${id}/reject`, 'marta.regulador', {
      comment: 'La finalidad no justifica datos de salud.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(subscriptionDetailSchema.parse(res.json()).status).toBe('rejected');
    expect(
      (await call('POST', `/regulator/subscriptions/${id}/approve`, 'marta.regulador', {}))
        .statusCode,
    ).toBe(409);
    expect(await actions(id)).toContain('subscription.rejected_regulator');
  });

  describe('authorization and separation of duties', () => {
    it('only the regulator sees the inbox and decides', async () => {
      const { versionId } = await waitingVersion();
      for (const who of ['ana.operadora', 'pablo.plataforma', 'sofia.auditora', 'lucia.datos']) {
        expect((await call('GET', '/regulator/approvals', who)).statusCode).toBe(403);
        expect(
          (await call('POST', `/regulator/api-versions/${versionId}/approve`, who, {})).statusCode,
        ).toBe(403);
      }
      // The operator cannot take the regulator's step through the review console either.
      expect(
        (await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {}))
          .statusCode,
      ).toBe(409);
    });

    it('a regulator who belongs to the provider or consumer entity cannot decide', async () => {
      const sub = randomUUID();
      const user = await prisma.user.create({
        data: {
          keycloakSub: sub,
          email: `reg.${sub.slice(0, 8)}@example.org`,
          fullName: 'Reguladora',
          createdBy: 'test',
        },
      });
      await prisma.userPlatformRole.create({
        data: { userId: user.id, role: 'regulator', grantedBy: 'test' },
      });
      await prisma.membership.create({
        data: {
          userId: user.id,
          entityId: programas,
          roles: ['entity_viewer'],
          status: 'active',
          createdBy: 'test',
        },
      });
      const id = await waitingRequest();
      expect(
        (await call('POST', `/regulator/subscriptions/${id}/approve`, { sub }, {})).statusCode,
      ).toBe(403);
      await prisma.membership.updateMany({ where: { userId: user.id }, data: { entityId: salud } });
      const { versionId } = await waitingVersion();
      expect(
        (await call('POST', `/regulator/api-versions/${versionId}/approve`, { sub }, {}))
          .statusCode,
      ).toBe(403);
    });

    it('nobody decides twice: the operator who approved a version cannot be its regulator', async () => {
      const { versionId } = await waitingVersion();
      const ana = await prisma.user.findUniqueOrThrow({
        where: { keycloakSub: subOf('ana.operadora') },
      });
      // Give the operator who approved it the regulator role too.
      await prisma.userPlatformRole.upsert({
        where: { userId_role: { userId: ana.id, role: 'regulator' } },
        create: { userId: ana.id, role: 'regulator', grantedBy: 'test' },
        update: {},
      });
      try {
        const res = await call(
          'POST',
          `/regulator/api-versions/${versionId}/approve`,
          'ana.operadora',
          {},
        );
        expect(res.statusCode).toBe(403);
      } finally {
        await prisma.userPlatformRole.delete({
          where: { userId_role: { userId: ana.id, role: 'regulator' } },
        });
      }
    });
  });
});
