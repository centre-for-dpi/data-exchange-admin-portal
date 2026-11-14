import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  createdApplicationSchema,
  type EntityRole,
  subscriptionDetailSchema,
  subscriptionPageSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OpaService } from '../opa/opa.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { addMonths, POLICY_SYNC_TOPIC } from './subscriptions.service.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

type Who = string | { sub: string };

describe('access requests and approval (M1-07)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';
  let personal = { apiId: '', versionId: '' };
  let applicationId = '';

  const call = async (method: 'GET' | 'POST', url: string, who?: Who, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: who
        ? {
            authorization: `Bearer ${await issuer.token(typeof who === 'string' ? subOf(who) : who.sub)}`,
          }
        : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function publishApi(slug: string, classification: string, publish = true) {
    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: `Afiliación ${slug}`,
      summary: 'Consulta de afiliación para solicitudes de acceso.',
      description: 'API de prueba con datos sintéticos.',
      sector: 'salud',
      tags: [],
      classification,
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
    const versionId = version.json<{ id: string }>().id;
    if (publish) {
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
    }
    return { apiId, versionId };
  }

  async function createApplication(who: Who = 'carlos.dev') {
    const res = await call('POST', `/entities/${programas}/applications`, who, {
      name: `Validador ${randomUUID().slice(0, 6)}`,
      description: 'Valida requisitos al asignar subsidios.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.rid.example',
    });
    expect(res.statusCode, res.body).toBe(201);
    return createdApplicationSchema.parse(res.json()).application.id;
  }

  /** A user with the given roles in each entity (by id). */
  async function userWith(memberships: Record<string, EntityRole[]>) {
    const sub = randomUUID();
    const user = await prisma.user.create({
      data: {
        keycloakSub: sub,
        email: `m107.${sub.slice(0, 8)}@example.org`,
        fullName: 'Test user',
        createdBy: 'system:test',
      },
    });
    for (const [entityId, roles] of Object.entries(memberships)) {
      await prisma.membership.create({
        data: { userId: user.id, entityId, roles, status: 'active', createdBy: 'system:test' },
      });
    }
    return { sub, userId: user.id };
  }

  const requestBody = (overrides: Record<string, unknown> = {}) => ({
    applicationId,
    apiVersionId: personal.versionId,
    purposeCode: 'eligibility_check',
    purposeDetail: 'Verificar afiliación al asignar el subsidio X.',
    legalBasisText: 'Ley de protección de datos, artículo 10, literal b.',
    validityMonths: 12,
    ...overrides,
  });

  async function requestAccess(overrides: Record<string, unknown> = {}, who: Who = 'carlos.dev') {
    const res = await call(
      'POST',
      `/entities/${programas}/subscriptions`,
      who,
      requestBody(overrides),
    );
    expect(res.statusCode, res.body).toBe(201);
    return subscriptionDetailSchema.parse(res.json());
  }

  const inbox = (id: string) => `/entities/${salud}/access-requests/${id}`;

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
    personal = await publishApi(`solicitudes-${run}`, 'personal');
    applicationId = await createApplication();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('request', () => {
    it('an app developer asks for access; the request waits for the provider', async () => {
      const s = await requestAccess();
      expect(s).toMatchObject({
        status: 'pending_provider',
        purpose: { code: 'eligibility_check' },
        application: { id: applicationId, entity: { slug: 'programas-sociales' } },
        api: { id: personal.apiId, entity: { slug: 'salud' } },
        requestedOperations: [],
        // An empty request stands for every read-only operation (GET), not the POST.
        effectiveRequestedOperations: ['getAfiliado'],
        approvedOperations: [],
        requestedValidityMonths: 12,
        maxValidityMonths: 12,
        endUserIdentificationRequired: true,
        requiresRegulator: false,
        decisions: [],
      });

      const events = await prisma.auditEvent.findMany({
        where: { targetType: 'subscription', targetId: s.id },
      });
      expect(events.map((e) => e.action)).toEqual(['subscription.requested']);
      expect(events[0]?.actorEntityId).toBe(programas);

      const duplicate = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        requestBody(),
      );
      expect(duplicate.statusCode).toBe(409);
    });

    it('rejects purposes, operations and validity the version does not allow', async () => {
      const appId = await createApplication();
      const res = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        requestBody({
          applicationId: appId,
          purposeCode: 'benefit_targeting',
          requestedOperations: ['getAfiliado', 'borrarTodo'],
          validityMonths: 13,
        }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toEqual([
        'purposeCode',
        'requestedOperations',
        'validityMonths',
      ]);
    });

    it('drafts are not requestable and another entity’s application is unknown', async () => {
      const draft = await publishApi(`borrador-${run}`, 'personal', false);
      const res = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        requestBody({ apiVersionId: draft.versionId }),
      );
      expect(res.statusCode).toBe(404);

      const foreignApp = await prisma.application
        .findFirstOrThrow({
          where: { entityId: { not: programas } },
        })
        .catch(() => undefined);
      if (foreignApp) {
        const foreign = await call(
          'POST',
          `/entities/${programas}/subscriptions`,
          'carlos.dev',
          requestBody({ applicationId: foreignApp.id }),
        );
        expect(foreign.statusCode).toBe(400);
      }
    });
  });

  describe('authorization', () => {
    it('only app developers of the consumer entity may request access', async () => {
      const viewer = await userWith({ [programas]: ['entity_viewer'] });
      expect(
        (await call('POST', `/entities/${programas}/subscriptions`, viewer, requestBody()))
          .statusCode,
      ).toBe(403);
      // pedro does not belong to the consumer entity.
      expect(
        (
          await call(
            'POST',
            `/entities/${programas}/subscriptions`,
            'pedro.publicador',
            requestBody(),
          )
        ).statusCode,
      ).toBe(404);
      // Members read their entity's requests.
      const list = await call('GET', `/entities/${programas}/subscriptions`, viewer);
      expect(list.statusCode).toBe(200);
    });

    it('only the provider’s data steward decides; others get 403, other entities 404', async () => {
      const s = await requestAccess({ applicationId: await createApplication() });
      const approve = (who: Who, entityId = salud) =>
        call('POST', `/entities/${entityId}/access-requests/${s.id}/approve`, who, {});

      expect((await approve('pedro.publicador')).statusCode).toBe(403);
      expect((await approve('carlos.dev')).statusCode).toBe(404);
      // The consumer entity's URL does not expose the provider inbox.
      expect((await approve('carlos.dev', programas)).statusCode).toBe(403);
      expect((await approve('ana.operadora')).statusCode).toBe(404);

      // The publisher reads the inbox; the consumer's developer does not.
      expect((await call('GET', inbox(s.id), 'pedro.publicador')).statusCode).toBe(200);
      expect(
        (await call('GET', `/entities/${programas}/access-requests`, 'carlos.dev')).statusCode,
      ).toBe(403);
      // A request to another provider is not found through salud's inbox.
      const consumerView = await call(
        'GET',
        `/entities/${programas}/subscriptions/${s.id}`,
        'carlos.dev',
      );
      expect(consumerView.statusCode).toBe(200);
      expect(
        (await call('GET', `/entities/${salud}/subscriptions/${s.id}`, 'lucia.datos')).statusCode,
      ).toBe(404);
    });
  });

  describe('decision', () => {
    it('lucia approves narrowing validity and operations; the policy sync is enqueued', async () => {
      const s = await requestAccess({
        applicationId: await createApplication(),
        requestedOperations: ['getAfiliado', 'verificarAfiliacion'],
        requestedRateLimit: 300,
      });
      const pending = await call(
        'GET',
        `/entities/${salud}/access-requests?status=pending_provider`,
        'lucia.datos',
      );
      expect(subscriptionPageSchema.parse(pending.json()).items.map((i) => i.id)).toContain(s.id);

      const before = Date.now();
      const res = await call('POST', `${inbox(s.id)}/approve`, 'lucia.datos', {
        approvedOperations: ['getAfiliado'],
        validityMonths: 6,
        rateLimitPerMinute: 120,
        comment: 'Aprobado para el subsidio X.',
      });
      expect(res.statusCode, res.body).toBe(200);
      const approved = subscriptionDetailSchema.parse(res.json());
      expect(approved).toMatchObject({
        status: 'approved',
        approvedOperations: ['getAfiliado'],
        rateLimitPerMinute: 120,
        requestedValidityMonths: 12,
        decisions: [
          { decision: 'approved', by: 'provider', comment: 'Aprobado para el subsidio X.' },
        ],
      });
      const validFrom = new Date(approved.validFrom);
      expect(validFrom.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(approved.validUntil).toBe(addMonths(validFrom, 6).toISOString());

      const actions = await prisma.auditEvent.findMany({
        where: { targetType: 'subscription', targetId: s.id },
        orderBy: { seq: 'asc' },
      });
      expect(actions.map((e) => e.action)).toEqual([
        'subscription.requested',
        'subscription.approved',
      ]);
      expect(actions[1]?.actorEntityId).toBe(salud);
      expect(
        await prisma.outboxMessage.count({
          where: { topic: POLICY_SYNC_TOPIC, aggregate: `subscription:${s.id}` },
        }),
      ).toBe(1);

      // Decided once: a second decision is an invalid transition.
      const again = await call('POST', `${inbox(s.id)}/reject`, 'lucia.datos', {
        comment: 'Ya no aplica para el subsidio.',
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'invalid_transition' });
    });

    it('the approval cannot widen the request', async () => {
      const s = await requestAccess({
        applicationId: await createApplication(),
        validityMonths: 3,
      });
      const res = await call('POST', `${inbox(s.id)}/approve`, 'lucia.datos', {
        approvedOperations: ['verificarAfiliacion'],
        validityMonths: 4,
        rateLimitPerMinute: 10_000,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toEqual([
        'approvedOperations',
        'validityMonths',
        'rateLimitPerMinute',
      ]);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
        'pending_provider',
      );
    });

    it('rejecting needs a reason the consumer sees; the slot frees for a new request', async () => {
      const appId = await createApplication();
      const s = await requestAccess({ applicationId: appId });
      expect(
        (await call('POST', `${inbox(s.id)}/reject`, 'lucia.datos', { comment: 'no' })).statusCode,
      ).toBe(400);
      const res = await call('POST', `${inbox(s.id)}/reject`, 'lucia.datos', {
        comment: 'La finalidad no corresponde al convenio vigente.',
      });
      expect(res.statusCode, res.body).toBe(200);

      const seen = subscriptionDetailSchema.parse(
        (await call('GET', `/entities/${programas}/subscriptions/${s.id}`, 'carlos.dev')).json(),
      );
      expect(seen).toMatchObject({
        status: 'rejected',
        decisions: [
          {
            decision: 'rejected',
            by: 'provider',
            comment: 'La finalidad no corresponde al convenio vigente.',
          },
        ],
      });
      expect(
        await prisma.outboxMessage.count({ where: { aggregate: `subscription:${s.id}` } }),
      ).toBe(0);
      await requestAccess({ applicationId: appId });
    });

    it('sensitive data moves the approval to the regulator, without syncing the gateway', async () => {
      const sensitive = await publishApi(`sensible-${run}`, 'sensitive');
      // Publishing a sensitive version also waits for the regulator, whose step arrives in M2-04:
      // the fixture takes that step directly in the database.
      await prisma.apiVersion.update({
        where: { id: sensitive.versionId },
        data: { status: 'published', publishedAt: new Date() },
      });
      const s = await requestAccess({
        applicationId: await createApplication(),
        apiVersionId: sensitive.versionId,
        validityMonths: 6,
      });
      expect(s.maxValidityMonths).toBe(6);
      expect(s.requiresRegulator).toBe(true);
      const res = await call('POST', `${inbox(s.id)}/approve`, 'lucia.datos', {});
      expect(res.json()).toMatchObject({ status: 'pending_regulator' });
      expect(
        await prisma.outboxMessage.count({ where: { aggregate: `subscription:${s.id}` } }),
      ).toBe(0);
      // The regulator's step is not the provider's to take.
      expect(
        (
          await call('POST', `${inbox(s.id)}/reject`, 'lucia.datos', {
            comment: 'Lo pienso mejor.',
          })
        ).statusCode,
      ).toBe(409);
    });
  });

  describe('separation of duties', () => {
    it('a steward of the provider who requested access cannot approve it', async () => {
      const both = await userWith({ [programas]: ['app_developer'], [salud]: ['data_steward'] });
      const s = await requestAccess({ applicationId: await createApplication() }, both);
      const res = await call('POST', `${inbox(s.id)}/approve`, both, {});
      expect(res.statusCode).toBe(403);
      expect(
        (await call('POST', `${inbox(s.id)}/reject`, both, { comment: 'Me rechazo a mí mismo.' }))
          .statusCode,
      ).toBe(403);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
        'pending_provider',
      );
      // Another steward can.
      expect((await call('POST', `${inbox(s.id)}/approve`, 'lucia.datos', {})).statusCode).toBe(
        200,
      );
    });

    it('nor can the steward who created the application another member used', async () => {
      const both = await userWith({ [programas]: ['app_developer'], [salud]: ['data_steward'] });
      const s = await requestAccess({ applicationId: await createApplication(both) }, 'carlos.dev');
      expect((await call('POST', `${inbox(s.id)}/approve`, both, {})).statusCode).toBe(403);
    });
  });

  describe('revocation (M1-10)', () => {
    const revoke = (
      id: string,
      who: Who,
      entityId = salud,
      comment = 'El convenio de intercambio terminó.',
    ) => call('POST', `/entities/${entityId}/access-requests/${id}/revoke`, who, { comment });

    /** An approved request, optionally already active (as OPA's status report would leave it). */
    async function granted(active: boolean) {
      const s = await requestAccess({ applicationId: await createApplication() });
      const approved = await call('POST', `${inbox(s.id)}/approve`, 'lucia.datos', {});
      expect(approved.statusCode, approved.body).toBe(200);
      if (active)
        await prisma.subscription.update({ where: { id: s.id }, data: { status: 'active' } });
      return s.id;
    }

    it('the data steward revokes an active subscription; the next bundle no longer grants it', async () => {
      const id = await granted(true);
      const opa = app.get(OpaService);
      const grantedIds = async () =>
        Object.values((await opa.data()).data.clients).flatMap((c) =>
          c.subscriptions.map((x) => x.id),
        );
      expect(await grantedIds()).toContain(id);

      expect((await revoke(id, 'lucia.datos', salud, 'corto')).statusCode).toBe(400);
      const res = await revoke(id, 'lucia.datos');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'revoked',
        decisions: [
          { decision: 'approved', by: 'provider' },
          { decision: 'revoked', by: 'provider', comment: 'El convenio de intercambio terminó.' },
        ],
      });
      expect(await grantedIds()).not.toContain(id);

      const actions = await prisma.auditEvent.findMany({
        where: { targetType: 'subscription', targetId: id },
        orderBy: { seq: 'asc' },
      });
      expect(actions.map((e) => e.action)).toEqual([
        'subscription.requested',
        'subscription.approved',
        'subscription.revoked',
      ]);
      expect(
        await prisma.outboxMessage.count({
          where: { topic: POLICY_SYNC_TOPIC, aggregate: `subscription:${id}` },
        }),
      ).toBe(2);

      // Final: nothing moves a revoked subscription, and the consumer reads the reason.
      const again = await revoke(id, 'lucia.datos');
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'invalid_transition' });
      const seen = await call('GET', `/entities/${programas}/subscriptions/${id}`, 'carlos.dev');
      expect(seen.json()).toMatchObject({ status: 'revoked' });
    });

    it('an approved subscription can be revoked before it activates; a pending request cannot', async () => {
      expect((await revoke(await granted(false), 'lucia.datos')).statusCode).toBe(200);
      const pending = await requestAccess({ applicationId: await createApplication() });
      expect((await revoke(pending.id, 'lucia.datos')).statusCode).toBe(409);
    });

    it('only the provider’s data steward revokes: others 403, other entities 404', async () => {
      const id = await granted(true);
      expect((await revoke(id, 'pedro.publicador')).statusCode).toBe(403);
      expect((await revoke(id, 'carlos.dev')).statusCode).toBe(404);
      expect((await revoke(id, 'carlos.dev', programas)).statusCode).toBe(403);
      expect((await revoke(id, 'ana.operadora')).statusCode).toBe(404);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id } })).status).toBe(
        'active',
      );
    });

    it('a steward may revoke access their own application requested (no separation of duties)', async () => {
      const both = await userWith({ [programas]: ['app_developer'], [salud]: ['data_steward'] });
      const s = await requestAccess({ applicationId: await createApplication(both) }, both);
      expect((await call('POST', `${inbox(s.id)}/approve`, 'lucia.datos', {})).statusCode).toBe(
        200,
      );
      expect((await revoke(s.id, both)).statusCode).toBe(200);
    });
  });

  it('decisions are append-only for the runtime role', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE subscription_decision SET comment = 'changed'`),
    ).rejects.toThrow(/permission denied/);
  });
});
