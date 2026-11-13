import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  createdApplicationSchema,
  subjectAccessWebhookSchema,
  subjectAlertsSchema,
  subscriptionDetailSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestCitizenIssuer,
  createTestIssuer,
  type TestCitizenIssuer,
  type TestIssuer,
} from '../../../test/test-auth.js';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { routeId } from '../../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../../seed/realm.js';
import { runSeed } from '../../seed/seed.js';
import { CITIZEN_TOKEN_VERIFIER } from '../citizen/citizen-token-verifier.js';
import { normalizeDocumentNumber, subjectRef, subjectRefKey } from '../subject-ref.js';
import { ALERT_TOPIC, SubjectAlertsService } from './subject-alerts.service.js';
import { verifyWebhook } from './webhook-signature.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const newNumber = () => `8${String(randomInt(100_000_000, 999_999_999))}`;

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

describe('citizen notices of new consultations (MT-06)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  const valentina = { sub: randomUUID(), number: newNumber() };
  const andres = { sub: randomUUID(), number: newNumber() };
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  const refOf = (number: string) =>
    subjectRef({
      key: subjectRefKey(),
      country: 'CO',
      documentType: 'CC',
      documentNumber: normalizeDocumentNumber(number),
    });
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let citizens: TestCitizenIssuer;
  let alerts: SubjectAlertsService;
  let versionId = '';
  let subscriptionId = '';
  /** Plays the Carpeta: records what it receives and answers with `status`. */
  let carpeta: Server;
  let received: Received[] = [];
  let status = 200;

  const call = async (method: 'GET' | 'POST', url: string, who: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(subOf(who))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const asCitizen = async (
    method: 'GET' | 'PUT',
    citizen: { sub: string; number: string } | null,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: '/api/v1/data-subjects/me/alerts',
      headers: citizen
        ? {
            authorization: `Bearer ${await citizens.token(citizen.sub, { documentNumber: citizen.number })}`,
          }
        : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const consulted = async (number: string, requestIds: string[] = [hex(16)]) => {
    const records = requestIds.map((id) => ({
      ts: (Date.now() / 1000).toFixed(3),
      gateway_node: `apisix-${run}`,
      gateway_request_id: id,
      route_id: routeId(versionId),
      operation: 'getAfiliado',
      subscription_id: subscriptionId,
      subject_ref: refOf(number),
      status: '200',
      upstream_status: '200',
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/subject-access',
      headers: { authorization: `Bearer ${process.env.RID_TRANSPARENCY_INGEST_TOKEN}` },
      payload: records,
    });
    expect(res.statusCode).toBe(200);
    return requestIds;
  };
  const queuedFor = (alertId: string) =>
    prisma.outboxMessage.findMany({
      where: { topic: ALERT_TOPIC, aggregate: { startsWith: `alert:${alertId}:` } },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    const salud = (await prisma.entity.findUniqueOrThrow({ where: { slug: 'salud' } })).id;
    const programas = (
      await prisma.entity.findUniqueOrThrow({ where: { slug: 'programas-sociales' } })
    ).id;
    issuer = await createTestIssuer();
    citizens = await createTestCitizenIssuer();
    app = await createTestApp(issuer, [
      { token: CITIZEN_TOKEN_VERIFIER, value: citizens.verifier },
    ]);
    alerts = app.get(SubjectAlertsService);

    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `avisos-${run}`,
      name: `Avisos ${run}`,
      summary: 'API para probar los avisos al titular.',
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
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Avisos ${run}`,
      description: 'Verifica afiliación.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.rid.example',
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
    const approved = await call(
      'POST',
      `/entities/${salud}/access-requests/${subscriptionId}/approve`,
      'lucia.datos',
      { validityMonths: 6 },
    );
    expect(approved.statusCode, approved.body).toBe(200);

    carpeta = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((done) => carpeta.listen(0, '127.0.0.1', done));
    const { port } = carpeta.address() as AddressInfo;
    process.env.RID_CITIZEN_APPS = JSON.stringify({
      'carpeta-ciudadana': { webhookUrl: `http://127.0.0.1:${port}/hook`, webhookSecret: secret },
    });
  });

  beforeEach(() => {
    received = [];
    status = 200;
  });

  afterAll(async () => {
    await new Promise((done) => carpeta.close(done));
    await app.close();
    await prisma.$disconnect();
  });

  describe('my notices', () => {
    it('take a citizen token only', async () => {
      expect((await asCitizen('GET', null)).statusCode).toBe(401);
      expect((await asCitizen('PUT', null, { classifications: [] })).statusCode).toBe(401);
      const portal = await app.inject({
        method: 'GET',
        url: '/api/v1/data-subjects/me/alerts',
        headers: { authorization: `Bearer ${await issuer.token(subOf('pablo.plataforma'))}` },
      });
      expect(portal.statusCode).toBe(401);
    });

    it('accept only classifications with a data subject', async () => {
      for (const payload of [
        { classifications: ['public'] },
        { classifications: ['personal'], email: 'x@example.org' },
        {},
      ]) {
        expect((await asCitizen('PUT', valentina, payload)).statusCode).toBe(400);
      }
    });

    it('are saved with an opaque id and audited without the person', async () => {
      expect(subjectAlertsSchema.parse((await asCitizen('GET', valentina)).json())).toEqual({
        alertId: null,
        classifications: [],
      });
      const saved = subjectAlertsSchema.parse(
        (await asCitizen('PUT', valentina, { classifications: ['sensitive', 'personal'] })).json(),
      );
      expect(saved).toEqual({
        alertId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        classifications: ['personal', 'sensitive'],
      });
      expect((await asCitizen('GET', valentina)).json()).toEqual(saved);

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'subject_alert.updated', targetId: saved.alertId ?? '' },
      });
      expect(event).toMatchObject({ actorType: 'application', actorId: 'carpeta-ciudadana' });
      const stored = JSON.stringify(event, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      expect(stored).not.toContain(valentina.number);
      expect(stored).not.toContain(refOf(valentina.number));
    });
  });

  describe('notices', () => {
    it('queue one per new matching consultation, never for retries or other people', async () => {
      const { alertId } = subjectAlertsSchema.parse(
        (await asCitizen('PUT', valentina, { classifications: ['personal'] })).json(),
      );
      const before = (await queuedFor(alertId ?? '')).length;
      const ids = await consulted(valentina.number, [hex(16), hex(16)]);
      await consulted(andres.number);
      expect((await queuedFor(alertId ?? '')).length).toBe(before + 2);
      // Fluent Bit retries the same chunk: already registered, not notified again.
      await consulted(valentina.number, ids);
      expect((await queuedFor(alertId ?? '')).length).toBe(before + 2);
      // Only sensitive data now: a personal-data consultation does not notify.
      await asCitizen('PUT', valentina, { classifications: ['sensitive'] });
      await consulted(valentina.number);
      expect((await queuedFor(alertId ?? '')).length).toBe(before + 2);
    });

    it('reach the Carpeta signed, with the opaque id and nothing about the person', async () => {
      const { alertId } = subjectAlertsSchema.parse(
        (await asCitizen('PUT', valentina, { classifications: ['personal'] })).json(),
      );
      await consulted(valentina.number);
      const [message] = (await queuedFor(alertId ?? '')).slice(-1);
      const job = {
        ...(message?.payload as Record<string, unknown>),
        aggregate: message?.aggregate,
      };

      expect(await alerts.deliver(job)).toBe('sent');
      expect(received).toHaveLength(1);
      const [got] = received;
      expect(
        verifyWebhook(
          secret,
          {
            'webhook-id': got?.headers['webhook-id'] as string,
            'webhook-timestamp': got?.headers['webhook-timestamp'] as string,
            'webhook-signature': got?.headers['webhook-signature'] as string,
          },
          got?.body ?? '',
        ),
      ).toBe(true);
      const body = subjectAccessWebhookSchema.parse(JSON.parse(got?.body ?? '{}'));
      expect(body.data).toMatchObject({ alertId, classification: 'personal' });
      expect(got?.body).not.toContain(valentina.number);
      expect(got?.body).not.toContain(refOf(valentina.number));
      // Same message id on a retry, so the Carpeta can drop duplicates.
      await alerts.deliver(job);
      expect(received[1]?.headers['webhook-id']).toBe(got?.headers['webhook-id']);
    });

    it('are retried while the Carpeta fails, and dropped once the citizen turns them off', async () => {
      const { alertId } = subjectAlertsSchema.parse(
        (await asCitizen('PUT', valentina, { classifications: ['personal'] })).json(),
      );
      await consulted(valentina.number);
      const [message] = (await queuedFor(alertId ?? '')).slice(-1);
      const job = {
        ...(message?.payload as Record<string, unknown>),
        aggregate: message?.aggregate,
      };

      status = 503;
      await expect(alerts.deliver(job)).rejects.toThrow(/503/);
      status = 200;
      await asCitizen('PUT', valentina, { classifications: [] });
      received = [];
      expect(await alerts.deliver(job)).toBe('skipped');
      expect(received).toEqual([]);
    });
  });
});
