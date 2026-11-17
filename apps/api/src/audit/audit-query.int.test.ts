import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  auditEventPageSchema,
  chainCheckSchema,
  createdApplicationSchema,
  subscriptionDetailSchema,
  timelineSchema,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { AuditService } from './audit.service.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

describe('audit trail: verification and timelines (M1-11)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';
  let socioeconomico = '';
  let apiId = '';
  let subscriptionId = '';

  const call = async (method: 'GET' | 'POST', url: string, who?: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: who ? { authorization: `Bearer ${await issuer.token(subOf(who))}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const timeline = async (url: string, who: string) => {
    const res = await call('GET', url, who);
    expect(res.statusCode, res.body).toBe(200);
    return timelineSchema.parse(res.json()).items;
  };

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    const id = async (slug: string) =>
      (await prisma.entity.findFirstOrThrow({ where: { slug } })).id;
    salud = await id('salud');
    programas = await id('programas-sociales');
    socioeconomico = await id('socioeconomico');
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);

    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `audit-${run}`,
      name: `Auditoría ${run}`,
      summary: 'API para probar la línea de tiempo.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      tags: [],
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
    const versionId = version.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {});

    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Validador ${run}`,
      description: 'Valida requisitos al asignar subsidios.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.den.example',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const requested = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar el subsidio X.',
      legalBasisText: 'Ley de protección de datos, artículo 10, literal b.',
      validityMonths: 12,
    });
    subscriptionId = subscriptionDetailSchema.parse(requested.json()).id;
    await call(
      'POST',
      `/entities/${salud}/access-requests/${subscriptionId}/approve`,
      'lucia.datos',
      {
        comment: 'Aprobado para el subsidio X.',
      },
    );
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('verification', () => {
    it('the operator, the regulator and auditors verify the chain; others cannot', async () => {
      for (const who of ['marta.regulador', 'sofia.auditora', 'ana.operadora']) {
        const res = await call('GET', '/audit/verify', who);
        expect(res.statusCode, who).toBe(200);
        expect(chainCheckSchema.parse(res.json())).toMatchObject({ valid: true });
      }
      expect((await call('GET', '/audit/verify', 'carlos.dev')).statusCode).toBe(403);
      expect((await call('GET', '/audit/verify', 'lucia.datos')).statusCode).toBe(403);
      expect((await call('GET', '/audit/verify')).statusCode).toBe(401);
    });
  });

  describe('platform view', () => {
    it('lists events newest first, by pages', async () => {
      const first = auditEventPageSchema.parse(
        (await call('GET', '/audit/events?limit=3', 'marta.regulador')).json(),
      );
      expect(first.items).toHaveLength(3);
      const seqs = first.items.map((i) => BigInt(i.seq));
      expect(seqs[0]! > seqs[1]! && seqs[1]! > seqs[2]!).toBe(true);
      const next = auditEventPageSchema.parse(
        (
          await call('GET', `/audit/events?limit=3&cursor=${first.nextCursor}`, 'marta.regulador')
        ).json(),
      );
      expect(BigInt(next.items[0]!.seq)).toBeLessThan(seqs[2]!);
      expect((await call('GET', '/audit/events', 'pedro.publicador')).statusCode).toBe(403);
    });

    it('shows a subscription’s timeline with names, status changes and comments', async () => {
      const items = await timeline(
        `/audit/timeline/subscription/${subscriptionId}`,
        'marta.regulador',
      );
      expect(items.map((i) => i.action)).toEqual([
        'subscription.requested',
        'subscription.approved',
      ]);
      expect(items[0]?.actor).toMatchObject({
        type: 'user',
        entity: { slug: 'programas-sociales' },
      });
      expect(items[0]?.actor.name).toBeTruthy();
      expect(items[1]).toMatchObject({
        status: { from: 'pending_provider', to: 'approved' },
        comment: 'Aprobado para el subsidio X.',
        actor: { entity: { slug: 'salud' } },
      });
      expect(items[1]?.actor.name).toBeTruthy();
      expect(items[1]?.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        (await call('GET', `/audit/timeline/subscription/${randomUUID()}`, 'marta.regulador'))
          .statusCode,
      ).toBe(404);
    });

    it('an API’s timeline includes its versions', async () => {
      const items = await timeline(`/audit/timeline/api/${apiId}`, 'ana.operadora');
      expect(items.map((i) => i.action)).toEqual(
        expect.arrayContaining([
          'api.created',
          'api_version.created',
          'api_version.approved',
          'api_version.published',
        ]),
      );
    });
  });

  describe('entity view', () => {
    const entityTimeline = (entityId: string, kind: string, id: string) =>
      `/entities/${entityId}/audit/timeline/${kind}/${id}`;

    it('both entities of a subscription see it, with names of their own people only', async () => {
      const consumer = await timeline(
        entityTimeline(programas, 'subscription', subscriptionId),
        'carlos.dev',
      );
      expect(consumer[0]?.actor.name).toBeTruthy(); // carlos, from the consumer entity
      expect(consumer[1]?.actor).toMatchObject({ name: null, entity: { slug: 'salud' } });

      const provider = await timeline(
        entityTimeline(salud, 'subscription', subscriptionId),
        'lucia.datos',
      );
      expect(provider[0]?.actor).toMatchObject({
        name: null,
        entity: { slug: 'programas-sociales' },
      });
      expect(provider[1]?.actor.name).toBeTruthy();
    });

    it('another entity gets 404; a non-member of the URL entity gets 404 too', async () => {
      // pedro belongs to socioeconomico, which is neither side of the subscription.
      expect(
        (
          await call(
            'GET',
            entityTimeline(socioeconomico, 'subscription', subscriptionId),
            'pedro.publicador',
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (await call('GET', entityTimeline(programas, 'api', apiId), 'carlos.dev')).statusCode,
      ).toBe(404);
      expect(
        (await call('GET', entityTimeline(salud, 'api', apiId), 'carlos.dev')).statusCode,
      ).toBe(404);
      expect(
        (await timeline(entityTimeline(salud, 'api', apiId), 'pedro.publicador')).length,
      ).toBeGreaterThan(0);
    });
  });
});
