import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { createdApplicationSchema, subscriptionDetailSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { MAIL_TRANSPORT, type MailMessage } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service.js';
import { POLICY_SYNC_TOPIC } from './subscriptions.service.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const DAY = 24 * 60 * 60 * 1000;

describe('subscription lifecycle (M2-06)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const sent: MailMessage[] = [];
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';
  let versionId = '';

  const call = async (method: 'GET' | 'POST', url: string, who: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(subOf(who))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

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
        token: MAIL_TRANSPORT,
        value: {
          send: (m: MailMessage) => {
            sent.push(m);
            return Promise.resolve();
          },
        },
      },
    ]);
    const slug = `vida-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: `Vida ${slug}`,
      summary: 'API para probar el ciclo de vida de suscripciones.',
      description: 'Datos sintéticos.',
      sector: 'salud',
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
        allowedPurposes: ['eligibility_check', 'identity_validation'],
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
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const body = (applicationId: string, extra: Record<string, unknown> = {}) => ({
    applicationId,
    apiVersionId: versionId,
    purposeCode: 'eligibility_check',
    purposeDetail: 'Verificar afiliación al asignar un subsidio.',
    legalBasisText: 'Ley de protección de datos, artículo 10.',
    validityMonths: 12,
    ...extra,
  });

  async function application() {
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Vida ${randomUUID().slice(0, 6)}`,
      description: 'Aplicación de prueba del ciclo de vida.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.rid.example',
    });
    return createdApplicationSchema.parse(created.json()).application.id;
  }

  async function requested(extra: Record<string, unknown> = {}) {
    const applicationId = await application();
    const res = await call(
      'POST',
      `/entities/${programas}/subscriptions`,
      'carlos.dev',
      body(applicationId, extra),
    );
    expect(res.statusCode, res.body).toBe(201);
    return { applicationId, id: subscriptionDetailSchema.parse(res.json()).id };
  }

  /** Approved by lucia and marked active, as OPA would after downloading the bundle. */
  async function active() {
    const r = await requested();
    const res = await call(
      'POST',
      `/entities/${salud}/access-requests/${r.id}/approve`,
      'lucia.datos',
      {},
    );
    expect(res.json()).toMatchObject({ status: 'approved' });
    await prisma.subscription.update({ where: { id: r.id }, data: { status: 'active' } });
    return r;
  }

  const provider = (id: string, action = '') => `/entities/${salud}/access-requests/${id}${action}`;
  const consumer = (id: string, action = '') =>
    `/entities/${programas}/subscriptions/${id}${action}`;
  const statusOf = async (id: string) =>
    (await prisma.subscription.findUniqueOrThrow({ where: { id } })).status;
  const actions = async (id: string) =>
    (await prisma.auditEvent.findMany({ where: { targetId: id }, orderBy: { seq: 'asc' } })).map(
      (e) => e.action,
    );

  it('the steward asks for information; the requester answers and corrects; back to the steward', async () => {
    const { id } = await requested();
    const res = await call('POST', provider(id, '/request-info'), 'lucia.datos', {
      comment: '¿Qué programa social usará los datos?',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(subscriptionDetailSchema.parse(res.json()).status).toBe('info_requested');
    // Only a pending request can be approved: the question has to be answered first.
    expect((await call('POST', provider(id, '/approve'), 'lucia.datos', {})).statusCode).toBe(409);
    // Sides cannot be swapped.
    expect(
      (
        await call('POST', provider(id, '/request-info'), 'carlos.dev', {
          comment: 'Pregunta propia.',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call('POST', consumer(id, '/provide-info'), 'lucia.datos', {
          comment: 'Respuesta ajena.',
        })
      ).statusCode,
    ).toBe(404);

    const answer = await call('POST', consumer(id, '/provide-info'), 'carlos.dev', {
      comment: 'El programa de subsidio de vivienda.',
      purposeDetail: 'Verificar afiliación al asignar el subsidio de vivienda.',
    });
    expect(answer.statusCode, answer.body).toBe(200);
    const detail = subscriptionDetailSchema.parse(answer.json());
    expect(detail.status).toBe('pending_provider');
    expect(detail.purposeDetail).toBe('Verificar afiliación al asignar el subsidio de vivienda.');
    expect(detail.decisions.map((d) => [d.decision, d.by])).toEqual([
      ['info_requested', 'provider'],
      ['info_provided', 'consumer'],
    ]);
    expect((await call('POST', provider(id, '/approve'), 'lucia.datos', {})).statusCode).toBe(200);
    expect(await actions(id)).toEqual(
      expect.arrayContaining([
        'subscription.info_requested',
        'subscription.info_provided',
        'subscription.approved',
      ]),
    );
  });

  it('the requester withdraws a pending request; not an approved one', async () => {
    const { id } = await requested();
    const res = await call('POST', consumer(id, '/withdraw'), 'carlos.dev', {});
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(id)).toBe('withdrawn');
    const approved = await active();
    expect(
      (await call('POST', consumer(approved.id, '/withdraw'), 'carlos.dev', {})).statusCode,
    ).toBe(409);
  });

  it('the steward suspends and reactivates; each change resyncs the policy', async () => {
    const { id } = await active();
    const res = await call('POST', provider(id, '/suspend'), 'lucia.datos', {
      comment: 'Uso fuera de la finalidad.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(id)).toBe('suspended');
    expect((await call('POST', provider(id, '/reactivate'), 'lucia.datos', {})).statusCode).toBe(
      200,
    );
    expect(await statusOf(id)).toBe('active');
    const reasons = (
      await prisma.outboxMessage.findMany({
        where: { topic: POLICY_SYNC_TOPIC, aggregate: `subscription:${id}` },
      })
    ).map((m) => (m.payload as { reason?: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(['suspended', 'reactivated']));
    // Other members of the provider cannot.
    expect(
      (
        await call('POST', provider(id, '/suspend'), 'pedro.publicador', {
          comment: 'No me corresponde.',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('a suspension by the regulator can only be lifted by a platform role', async () => {
    const { id } = await active();
    const res = await call('POST', provider(id, '/suspend'), 'marta.regulador', {
      comment: 'Investigación en curso.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(subscriptionDetailSchema.parse(res.json()).decisions.at(-1)).toMatchObject({
      decision: 'suspended',
      by: 'platform',
    });
    expect((await call('POST', provider(id, '/reactivate'), 'lucia.datos', {})).statusCode).toBe(
      403,
    );
    expect(
      (await call('POST', provider(id, '/reactivate'), 'marta.regulador', {})).statusCode,
    ).toBe(200);
    // The operator can revoke too.
    const revoke = await call('POST', provider(id, '/revoke'), 'pablo.plataforma', {
      comment: 'Incumplimiento del acuerdo.',
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect(await statusOf(id)).toBe('revoked');
  });

  it('expires granted subscriptions past their validity, once', async () => {
    const { id } = await active();
    await prisma.subscription.update({
      where: { id },
      data: { validUntil: new Date(Date.now() - 1000) },
    });
    const lifecycle = app.get(SubscriptionLifecycleService);
    expect(await lifecycle.expireDue()).toContain(id);
    expect(await statusOf(id)).toBe('expired');
    expect(await lifecycle.expireDue()).not.toContain(id);
    expect(await actions(id)).toContain('subscription.expired');
  });

  it('e-mails the requester once when the renewal notice period starts', async () => {
    const { id } = await active();
    await prisma.subscription.update({
      where: { id },
      data: { validUntil: new Date(Date.now() + 10 * DAY) },
    });
    const lifecycle = app.get(SubscriptionLifecycleService);
    expect(await lifecycle.queueRenewalNotices()).toContain(id);
    expect(await lifecycle.queueRenewalNotices()).not.toContain(id);
    await lifecycle.sendRenewalNotice({ subscriptionId: id });
    const carlos = realmUsers.find((u) => u.username === 'carlos.dev');
    const mail = sent.find((m) => m.to === carlos?.email && m.text.includes(id));
    expect(mail?.subject).toMatch(/vence el/);
  });

  describe('renewal', () => {
    it('a prefilled request lives next to the active subscription; one renewal at a time', async () => {
      const { id, applicationId } = await active();
      const res = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        body(applicationId, { renewsSubscriptionId: id }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const renewal = subscriptionDetailSchema.parse(res.json());
      expect(renewal).toMatchObject({ status: 'pending_provider', renewsSubscriptionId: id });
      const original = subscriptionDetailSchema.parse(
        (await call('GET', consumer(id), 'carlos.dev')).json(),
      );
      expect(original.renewal).toEqual({ id: renewal.id, status: 'pending_provider' });
      expect(await statusOf(id)).toBe('active');

      const twice = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        body(applicationId, { renewsSubscriptionId: id }),
      );
      expect(twice.statusCode).toBe(409);
      const plain = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        body(applicationId),
      );
      expect(plain.statusCode).toBe(409);
      // No renewal notice while a renewal is in progress.
      await prisma.subscription.update({
        where: { id },
        data: { validUntil: new Date(Date.now() + 5 * DAY) },
      });
      expect(await app.get(SubscriptionLifecycleService).queueRenewalNotices()).not.toContain(id);
      expect(await actions(renewal.id)).toContain('subscription.renewal_requested');
    });

    const renew = async (id: string, applicationId: string) => {
      const res = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        body(applicationId, { renewsSubscriptionId: id }),
      );
      expect(res.statusCode, res.body).toBe(201);
      return subscriptionDetailSchema.parse(res.json()).id;
    };

    it('suspending the subscription closes its pending renewal', async () => {
      const { id, applicationId } = await active();
      const renewal = await renew(id, applicationId);
      const res = await call('POST', provider(id, '/suspend'), 'marta.regulador', {
        comment: 'Investigación en curso.',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await statusOf(renewal)).toBe('rejected');
      const closed = await prisma.auditEvent.findFirstOrThrow({
        where: { targetId: renewal, action: 'subscription.rejected' },
      });
      expect(closed.after).toMatchObject({ reason: 'renewed_subscription_suspended' });
    });

    it('revoking the subscription revokes an already granted renewal', async () => {
      const { id, applicationId } = await active();
      const renewal = await renew(id, applicationId);
      expect(
        (await call('POST', provider(renewal, '/approve'), 'lucia.datos', {})).statusCode,
      ).toBe(200);
      const res = await call('POST', provider(id, '/revoke'), 'pablo.plataforma', {
        comment: 'Incumplimiento del acuerdo.',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await statusOf(renewal)).toBe('revoked');
    });

    it('a renewal cannot be approved while the subscription it renews is not active', async () => {
      const { id, applicationId } = await active();
      const renewal = await renew(id, applicationId);
      await prisma.subscription.update({ where: { id }, data: { status: 'suspended' } });
      const res = await call('POST', provider(renewal, '/approve'), 'lucia.datos', {});
      expect(res.statusCode).toBe(409);
      expect(await statusOf(renewal)).toBe('pending_provider');
    });

    it('keeps the application, version and purpose, and only renews active subscriptions', async () => {
      const { id, applicationId } = await active();
      const other = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        body(applicationId, {
          renewsSubscriptionId: id,
          purposeCode: 'identity_validation',
        }),
      );
      expect(other.statusCode).toBe(400);
      const pending = await requested();
      const notActive = await call(
        'POST',
        `/entities/${programas}/subscriptions`,
        'carlos.dev',
        body(pending.applicationId, { renewsSubscriptionId: pending.id }),
      );
      expect(notActive.statusCode).toBe(409);
    });
  });
});
