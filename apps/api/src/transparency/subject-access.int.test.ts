import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { createdApplicationSchema, subscriptionDetailSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { routeId } from '../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { SubjectAccessService } from './subject-access.service.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

describe('transparency register collector (MT-03)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  const token = process.env.DEN_TRANSPARENCY_INGEST_TOKEN ?? '';
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';
  let apiId = '';
  let versionId = '';
  let applicationId = '';
  let subscriptionId = '';

  const call = async (method: 'POST', url: string, who: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(subOf(who))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const ingest = (payload: unknown, authorization = `Bearer ${token}`) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/internal/subject-access',
      headers: { authorization },
      payload: payload as object,
    });

  /** A record as the gateway's Fluent Bit sends it (TRANSPARENCY_LOG_FORMAT). */
  const record = (overrides: Record<string, unknown> = {}) => ({
    ts: (Date.now() / 1000).toFixed(3),
    gateway_node: `apisix-${run}`,
    gateway_request_id: hex(16),
    request_id: `req-${randomUUID()}`,
    route_id: routeId(versionId),
    operation: 'getAfiliado',
    subscription_id: subscriptionId,
    consumer_entity: 'programas-sociales',
    consumer_app: 'whatever-the-header-said',
    purpose: 'eligibility_check',
    end_user_hash: hex(32),
    subject_ref: hex(32),
    status: '200',
    upstream_status: '200',
    ...overrides,
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
    app = await createTestApp(issuer);

    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `transparencia-${run}`,
      name: `Transparencia ${run}`,
      summary: 'API para probar el registro de transparencia.',
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
    versionId = version.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {});

    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Verificador ${run}`,
      description: 'Verifica afiliación.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.den.example',
    });
    applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const requested = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar el subsidio X.',
      legalBasisText: 'Ley de protección de datos, artículo 10, literal b.',
      validityMonths: 12,
    });
    subscriptionId = subscriptionDetailSchema.parse(requested.json()).id;
    const approved = await call(
      'POST',
      `/entities/${salud}/access-requests/${subscriptionId}/approve`,
      'lucia.datos',
      { validityMonths: 6 },
    );
    expect(approved.statusCode, approved.body).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authorization', () => {
    it('accepts only the ingest service token', async () => {
      const anonymous = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/subject-access',
        payload: [],
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['content-type']).toMatch(/problem\+json/);
      expect((await ingest([], 'Bearer wrong-token')).statusCode).toBe(401);
      // Not the OPA token either, nor a user token.
      expect((await ingest([], `Bearer ${process.env.OPA_BUNDLE_TOKEN}`)).statusCode).toBe(401);
      expect((await call('POST', '/internal/subject-access', 'ana.operadora', [])).statusCode).toBe(
        401,
      );
      // The token is checked before the body: no hint about the expected shape.
      expect((await ingest({ not: 'an array' }, 'Bearer wrong-token')).statusCode).toBe(401);
      expect((await ingest({ not: 'an array' })).statusCode).toBe(400);
    });

    it('rejects an unauthenticated caller before reading the body', async () => {
      // Over the API's default limit, under the collector's: only a valid token gets it parsed.
      // More rows than one INSERT can carry (65,535 parameters), so it also goes in slices.
      const large = Array.from({ length: 5_000 }, () => record());
      expect(JSON.stringify(large).length).toBeGreaterThan(1024 * 1024);
      const anonymous = await ingest(large, 'Bearer wrong-token');
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['content-type']).toMatch(/problem\+json/);
      expect(anonymous.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
      const accepted = await ingest(large);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ accepted: 5_000, duplicates: 0 });
    });
  });

  describe('ingest', () => {
    it('stores each call with the provider, API, exposed data and purpose of its subscription', async () => {
      const byPath = record();
      const byBody = record({ operation: 'verificarAfiliacion', end_user_hash: '' });
      const res = await ingest([byPath, byBody]);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ accepted: 2, duplicates: 0, dropped: {} });

      const rows = await prisma.subjectAccessRecord.findMany({
        where: {
          subscriptionId,
          gatewayRequestId: { in: [byPath.gateway_request_id, byBody.gateway_request_id] },
        },
        orderBy: { operationId: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        operationId: 'getAfiliado',
        subjectSource: 'path',
        subjectRef: byPath.subject_ref,
        gatewayRequestId: byPath.gateway_request_id,
        providerEntityId: salud,
        apiId,
        apiVersionId: versionId,
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
        // From the subscription OPA authorized, not from the consumer's headers.
        consumerEntityId: programas,
        applicationId,
        purposeCode: 'eligibility_check',
        endUserHash: byPath.end_user_hash,
        status: 200,
      });
      expect(rows[0]?.occurredAt.getTime()).toBe(Math.round(Number(byPath.ts) * 1000));
      expect(rows[1]).toMatchObject({
        operationId: 'verificarAfiliacion',
        subjectSource: 'body',
        endUserHash: null,
      });
      // The consumer's X-Request-Id is not kept next to the pseudonym (M-16).
      expect(JSON.stringify(rows)).not.toContain(byPath.request_id);
    });

    it('ignores retries of the same call', async () => {
      const once = record();
      expect((await ingest([once])).json()).toMatchObject({ accepted: 1 });
      expect((await ingest([once, once])).json()).toMatchObject({ accepted: 0, duplicates: 2 });
      expect(
        await prisma.subjectAccessRecord.count({
          where: { gatewayRequestId: once.gateway_request_id },
        }),
      ).toBe(1);
      // The client-chosen X-Request-Id is not the key: two calls may share it.
      const shared = `req-${randomUUID()}`;
      expect(
        (await ingest([record({ request_id: shared }), record({ request_id: shared })])).json(),
      ).toMatchObject({ accepted: 2 });
    });

    it('registers the call whatever X-Request-Id the consumer sent (A-4)', async () => {
      // A gateway still on the old log format carries it; it is ignored, never a reason to drop.
      const long = record({ request_id: 'a'.repeat(4096) });
      expect((await ingest([long])).json()).toEqual({ accepted: 1, duplicates: 0, dropped: {} });
    });

    it('drops records that do not match an authorized call, and keeps the rest of the batch', async () => {
      const good = record();
      const res = await ingest([
        good,
        record({ subject_ref: '1000000001' }), // a document number is not a reference
        record({ upstream_status: '' }), // never reached the provider
        record({ gateway_request_id: 'chosen-by-client' }),
        'not an object',
        record({ subscription_id: randomUUID() }),
        record({ route_id: routeId(randomUUID()) }),
        record({ operation: 'getEstadisticas' }),
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        accepted: 1,
        duplicates: 0,
        dropped: { invalid: 4, unknown_subscription: 1, route_mismatch: 1, no_subject: 1 },
      });
      expect(
        await prisma.subjectAccessRecord.count({
          where: { gatewayRequestId: good.gateway_request_id },
        }),
      ).toBe(1);
    });
  });

  describe('insert-only store and retention', () => {
    it('refuses updates and deletes from the runtime role', async () => {
      const row = await prisma.subjectAccessRecord.findFirstOrThrow({ where: { subscriptionId } });
      await expect(
        prisma.subjectAccessRecord.update({ where: { id: row.id }, data: { status: 500 } }),
      ).rejects.toThrow();
      await expect(prisma.subjectAccessRecord.delete({ where: { id: row.id } })).rejects.toThrow();
      await expect(prisma.$executeRawUnsafe('TRUNCATE subject_access_record')).rejects.toThrow();
      // Nor can it switch the purge flag on and delete by itself.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('den.subject_access_purge', 'on', true)`;
          await tx.$executeRaw`DELETE FROM subject_access_record WHERE id = ${row.id}::uuid`;
        }),
      ).rejects.toThrow();
    });

    it('purges only what is past retention, and audits it', async () => {
      const months = loadCountryConfig({ code: 'co' }).retention.subjectAccessMonths;
      const old = new Date();
      old.setMonth(old.getMonth() - months - 1);
      const expired = record({ ts: (old.getTime() / 1000).toFixed(3) });
      const recent = record();
      expect((await ingest([expired, recent])).json()).toMatchObject({ accepted: 2 });

      const service = app.get(SubjectAccessService);
      expect(await service.purgeExpired()).toBeGreaterThanOrEqual(1);
      const left = await prisma.subjectAccessRecord.findMany({
        where: {
          gatewayRequestId: { in: [expired.gateway_request_id, recent.gateway_request_id] },
        },
      });
      expect(left.map((r) => r.gatewayRequestId)).toEqual([recent.gateway_request_id]);
      const event = await prisma.auditEvent.findFirst({
        where: { action: 'subject_access.purged' },
        orderBy: { seq: 'desc' },
      });
      expect(event).toMatchObject({ actorType: 'system', actorId: 'transparency-retention' });
      expect(event?.after).toMatchObject({ retentionMonths: months });

      // Nothing else to purge: no event for an empty purge.
      const before = await prisma.auditEvent.count({ where: { action: 'subject_access.purged' } });
      expect(await service.purgeExpired()).toBe(0);
      expect(await prisma.auditEvent.count({ where: { action: 'subject_access.purged' } })).toBe(
        before,
      );
      // Every purge is logged by the database itself, whoever called it.
      const logged = await prisma.subjectAccessPurgeLog.findFirstOrThrow({
        orderBy: { purgedAt: 'desc' },
      });
      expect(logged).toMatchObject({ calledBy: 'den_app', retentionMonths: months, deleted: 0n });

      // The runtime role cannot shorten retention: the floor is the schema owner's, and the
      // database refuses anything under it.
      await expect(prisma.$queryRaw`SELECT purge_subject_access_records(0)`).rejects.toThrow();
      await expect(prisma.$queryRaw`SELECT purge_subject_access_records(1)`).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE subject_access_retention SET min_months = 1`,
      ).rejects.toThrow();
      // Nor shadow the floor with a temporary table of its own (search_path hijack).
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`CREATE TEMP TABLE subject_access_retention (min_months integer) ON COMMIT DROP`;
          await tx.$executeRaw`INSERT INTO subject_access_retention VALUES (1)`;
          await tx.$queryRaw`SELECT purge_subject_access_records(1)`;
        }),
      ).rejects.toThrow(/at least \d+ months/);
      await expect(
        prisma.$executeRaw`DELETE FROM subject_access_purge_log WHERE true`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`INSERT INTO subject_access_purge_log (called_by, retention_months, min_months, deleted) VALUES ('x', 1, 1, 0)`,
      ).rejects.toThrow();
    });
  });
});
