import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  createdApplicationSchema,
  notificationPageSchema,
  notificationPreferencesSchema,
  subscriptionDetailSchema,
} from '@den/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { MAIL_TRANSPORT, type MailMessage } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { NotificationsService } from './notifications.service.js';
import { NOTIFICATION_TOPIC } from './notifying-actions.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

describe('notifications (M2-08)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const user = (username: string) => realmUsers.find((u) => u.username === username);
  const sent: MailMessage[] = [];
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';
  let versionId = '';
  let apiId = '';

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(user(who)?.id ?? '')}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** Runs the dispatcher on the latest event with that action and target, as the worker would. */
  const dispatch = async (targetId: string, action: string) => {
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId, action },
      orderBy: { seq: 'desc' },
    });
    return app.get(NotificationsService).dispatch({ seq: event.seq.toString() });
  };
  const userId = async (username: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { keycloakSub: user(username)?.id ?? '' } })).id;
  const mailsTo = (username: string) => sent.filter((m) => m.to === user(username)?.email);

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
    const slug = `aviso-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: `Aviso ${slug}`,
      summary: 'API para probar notificaciones.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@salud.demo.den.example',
    });
    apiId = api.json<{ id: string }>().id;
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
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    sent.length = 0;
    // Preferences of other runs must not leak into this one.
    await prisma.notificationPreference.deleteMany({
      where: { userId: { in: [await userId('lucia.datos'), await userId('carlos.dev')] } },
    });
  });

  async function requested() {
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Aviso ${randomUUID().slice(0, 6)}`,
      description: 'Aplicación de prueba de notificaciones.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.den.example',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const res = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar un subsidio.',
      legalBasisText: 'Ley de protección de datos, artículo 10.',
      validityMonths: 12,
    });
    return subscriptionDetailSchema.parse(res.json()).id;
  }

  it('queues the dispatch with the audit event, in the same transaction', async () => {
    const id = await requested();
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: id, action: 'subscription.requested' },
    });
    const outbox = await prisma.outboxMessage.findMany({
      where: { topic: NOTIFICATION_TOPIC, aggregate: `audit:${event.seq}` },
    });
    expect(outbox).toHaveLength(1);
  });

  it('tells the data steward of a new request, not the requester, once, in the portal and by e-mail', async () => {
    const id = await requested();
    expect(await dispatch(id, 'subscription.requested')).toBeGreaterThan(0);
    await dispatch(id, 'subscription.requested');
    const lucia = await prisma.notification.findMany({
      where: { userId: await userId('lucia.datos'), kind: 'access_requested' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    expect(
      lucia.filter((n) => (n.payload as { link: string }).link === `/requests/${id}`),
    ).toHaveLength(1);
    expect(
      await prisma.notification.count({
        where: { userId: await userId('carlos.dev'), kind: 'access_requested' },
      }),
    ).toBe(0);
    const mails = mailsTo('lucia.datos').filter((m) => m.text.includes(`/requests/${id}`));
    expect(mails).toHaveLength(1);
    // Fixed subject (B-10): what third parties typed goes in the body only.
    expect(mails[0]?.subject).toBe('Nueva solicitud de acceso');
    expect(mails[0]?.text).toContain('pide acceso');
  });

  it('lists, counts and marks notifications as read, only one’s own', async () => {
    const id = await requested();
    await dispatch(id, 'subscription.requested');
    const page = notificationPageSchema.parse(
      (await call('GET', '/me/notifications?unread=true', 'lucia.datos')).json(),
    );
    expect(page.unread).toBeGreaterThan(0);
    const mine = page.items.find((n) => n.link === `/requests/${id}`);
    expect(mine).toMatchObject({
      kind: 'access_requested',
      readAt: null,
      params: { application: expect.any(String) as string },
    });
    expect(
      (await call('POST', `/me/notifications/${mine?.id}/read`, 'carlos.dev')).statusCode,
    ).toBe(404);
    const read = await call('POST', `/me/notifications/${mine?.id}/read`, 'lucia.datos');
    expect(read.json()).toMatchObject({ readAt: expect.any(String) as string });
    expect((await call('POST', '/me/notifications/read-all', 'lucia.datos')).statusCode).toBe(200);
    expect(
      notificationPageSchema.parse((await call('GET', '/me/notifications', 'lucia.datos')).json())
        .unread,
    ).toBe(0);
  });

  it('honours e-mail preferences, but always e-mails security notices', async () => {
    const prefs = await call('PUT', '/me/notification-preferences', 'lucia.datos', {
      items: [{ kind: 'access_requested', email: false }],
    });
    expect(prefs.statusCode, prefs.body).toBe(200);
    const id = await requested();
    await dispatch(id, 'subscription.requested');
    expect(mailsTo('lucia.datos').filter((m) => m.text.includes(id))).toHaveLength(0);
    expect(
      await prisma.notification.count({
        where: {
          userId: await userId('lucia.datos'),
          payload: { path: ['link'], equals: `/requests/${id}` },
        },
      }),
    ).toBe(1);

    // carlos tries to turn off suspension notices: it is locked.
    const locked = notificationPreferencesSchema.parse(
      (
        await call('PUT', '/me/notification-preferences', 'carlos.dev', {
          items: [{ kind: 'access_suspended', email: false }],
        })
      ).json(),
    );
    expect(locked.items.find((i) => i.kind === 'access_suspended')).toEqual({
      kind: 'access_suspended',
      email: true,
      locked: true,
    });
    await call('POST', `/entities/${salud}/access-requests/${id}/approve`, 'lucia.datos', {});
    await prisma.subscription.update({ where: { id }, data: { status: 'active' } });
    await call('POST', `/entities/${salud}/access-requests/${id}/suspend`, 'lucia.datos', {
      comment: 'Revisión del uso de datos.',
    });
    await dispatch(id, 'subscription.suspended');
    const suspended = mailsTo('carlos.dev').filter((m) => m.text.includes(id));
    expect(suspended.some((m) => m.subject === 'Acceso suspendido')).toBe(true);
    expect(
      await prisma.auditEvent.count({
        where: { action: 'notification_preference.updated', targetId: await userId('carlos.dev') },
      }),
    ).toBe(0);
  });

  it('does not tell a requester who no longer belongs to the consumer entity', async () => {
    const id = await requested();
    const carlos = await userId('carlos.dev');
    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: carlos, entityId: programas },
    });
    await prisma.membership.update({ where: { id: membership.id }, data: { status: 'revoked' } });
    try {
      await call('POST', `/entities/${salud}/access-requests/${id}/request-info`, 'lucia.datos', {
        comment: '¿Para qué programa son los datos?',
      });
      await dispatch(id, 'subscription.info_requested');
      expect(
        await prisma.notification.count({
          where: {
            userId: carlos,
            kind: 'access_info_requested',
            payload: { path: ['link'], equals: `/my-apps/requests/${id}` },
          },
        }),
      ).toBe(0);
    } finally {
      await prisma.membership.update({ where: { id: membership.id }, data: { status: 'active' } });
    }
  });

  it('tells operator reviewers a version waits for review, not its publisher', async () => {
    const res = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      {
        version: '2.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: ['eligibility_check'],
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
      },
    );
    const v2 = res.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${v2}/submit`,
      'pedro.publicador',
    );
    await dispatch(v2, 'api_version.submitted');
    const forAna = await prisma.notification.count({
      where: {
        userId: await userId('ana.operadora'),
        kind: 'api_review_requested',
        payload: { path: ['link'], equals: `/operator/reviews/${v2}` },
      },
    });
    expect(forAna).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: await userId('pedro.publicador'), kind: 'api_review_requested' },
      }),
    ).toBe(0);
  });
});
