import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { exchangeMapSchema, networkIndicatorsSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { localDay } from '../common/local-day.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { routeId, sandboxRouteId } from '../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { AccessLogIndexReconciler } from './access-log-index.js';
import { HttpOpenSearch, openSearchUrl } from './opensearch.js';
import { PROMETHEUS } from './prometheus.js';

/**
 * The network's indicators (SPEC.md §8, M5-04), against PostgreSQL and the real OpenSearch. A
 * fresh provider with a node and an API published in June 2025, and its calls in an index of the
 * test's own: no other run has data in that month. Prometheus is a fake.
 */
describe("the network's indicators (M5-04)", () => {
  const prisma = new PrismaService();
  const audit = new AuditService();
  const openSearch = new HttpOpenSearch(openSearchUrl());
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 8);
  const index = `den-access-test-indicators-${run}`;
  const queries: string[] = [];
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let entityId = '';
  let apiId = '';

  beforeAll(async () => {
    await runSeed(prisma, audit, { config: loadCountryConfig({ code: 'co' }), realmUsers });
    entityId = (
      await prisma.entity.create({
        data: {
          legalName: `Proveedor indicadores ${run}`,
          shortName: `Indicadores ${run}`,
          slug: `indicadores-${run}`,
          taxIdType: 'NIT',
          taxId: `5${run}`,
          kind: 'territorial',
          sector: 'salud',
          status: 'active',
          contactEmail: `c.${run}@example.org`,
          dpoName: 'Dora',
          dpoEmail: `d.${run}@example.org`,
          createdBy: 'test',
          createdAt: new Date('2025-05-01T15:00:00Z'),
        },
      })
    ).id;
    // The kit's node, enrolled before the first call: it starts the clock.
    await prisma.node.create({
      data: {
        entityId,
        name: `nodo-${run}`,
        status: 'online',
        enrolledAt: new Date('2025-05-25T15:00:00Z'),
        createdBy: 'test',
      },
    });
    const api = await prisma.api.create({
      data: {
        entityId,
        slug: `indicadores-${run}`,
        name: `Indicadores ${run}`,
        summary: 'API de prueba de los indicadores.',
        description: 'API de prueba.',
        sector: 'salud',
        classification: 'personal',
        ownerContact: 'apis@example.org',
        status: 'published',
        createdBy: 'test',
      },
    });
    apiId = api.id;
    const versionId = (
      await prisma.apiVersion.create({
        data: {
          apiId,
          version: '1.0',
          major: 1,
          minor: 0,
          status: 'published',
          publishedAt: new Date('2025-06-01T15:00:00Z'),
          openapiSpec: {},
          openapiSha256: '0'.repeat(64),
          upstreamType: 'node',
          upstream: { type: 'node', servicePath: '/salud' },
          basePath: `/test/indicadores-${run}/v1`,
          createdBy: 'test',
        },
      })
    ).id;
    await prisma.bootcampChecklistItem.create({
      data: {
        entityId,
        item: 'use_case',
        status: 'done',
        note: 'Certificados para subsidios',
        manualStepsAvoided: 4,
        updatedBy: (await prisma.user.findFirstOrThrow()).id,
      },
    });

    await new AccessLogIndexReconciler(prisma, openSearch).reconcileTemplate();
    const route = routeId(versionId);
    const call = (ts: string, status: number, extra: Record<string, unknown> = {}) => ({
      ts,
      route_id: route,
      status,
      method: 'GET',
      latency_ms: 10,
      consumer_entity: 'programas-sociales',
      ...extra,
    });
    const docs = [
      call('2025-06-02T15:00:00Z', 200),
      call('2025-06-03T15:00:00Z', 200),
      call('2025-06-04T15:00:00Z', 200),
      call('2025-06-05T15:00:00Z', 403, { deny_reason: 'purpose_not_allowed' }),
      call('2025-06-05T16:00:00Z', 401),
      call('2025-06-06T15:00:00Z', 500),
      // Not production traffic: the sandbox and a validation check.
      call('2025-06-06T15:00:00Z', 200, { route_id: sandboxRouteId(versionId) }),
      call('2025-06-06T15:00:00Z', 200, { route_id: `den-check-${versionId}` }),
    ];
    const body =
      docs
        .flatMap((d) => [JSON.stringify({ index: { _index: index } }), JSON.stringify(d)])
        .join('\n') + '\n';
    const res = await fetch(`${openSearchUrl()}/_bulk?refresh=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
    });
    expect(((await res.json()) as { errors: boolean }).errors).toBe(false);

    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      {
        token: PROMETHEUS,
        value: {
          instant: (query: string) => {
            queries.push(query);
            return Promise.resolve(0.9951);
          },
        },
      },
    ]);
  });

  afterAll(async () => {
    await openSearch.request('DELETE', `/${index}`);
    await app.close();
    await prisma.$disconnect();
  });

  const get = async (url: string, username: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(sub(username))}` },
    });

  it('computes the indicators of a month from the logs, the portal and Prometheus', async () => {
    const res = await get('/network/indicators?from=2025-06-01&to=2025-06-30', 'marta.regulador');
    expect(res.statusCode, res.body).toBe(200);
    const indicators = networkIndicatorsSchema.parse(res.json());

    // 2xx over the calls, without the authorization refusals (reported apart).
    expect(indicators.successfulCalls).toMatchObject({
      calls: 6,
      ok: 3,
      authorizationRefused: 2,
      rate: 0.75,
    });
    expect(indicators.successfulCalls.refusedByReason).toEqual([
      { reason: 'purpose_not_allowed', calls: 1 },
    ]);
    expect(indicators.apisInUse.items).toEqual([
      { apiId, apiName: `Indicadores ${run}`, providerName: `Indicadores ${run}`, calls: 3 },
    ]);
    expect(indicators.apisInUse.published).toBeGreaterThanOrEqual(1);

    // From the node's enrollment (May 25th) to the first call (June 2nd): 8 days.
    const mine = indicators.timeToFirstUse.entities.find((e) => e.entityId === entityId);
    expect(mine).toMatchObject({
      sinceKind: 'node',
      since: '2025-05-25T15:00:00.000Z',
      firstCallAt: '2025-06-02T15:00:00.000Z',
      days: 8,
    });

    const june = indicators.connectedEntities.byMonth.find((m) => m.month === '2025-06');
    expect(june?.count).toBeGreaterThanOrEqual(1);
    expect(indicators.connectedEntities.byMonth).toHaveLength(12);
    expect(indicators.connectedEntities.byMonth.at(-1)?.month).toBe('2025-06');

    expect(indicators.gatewayAvailability.percent).toBe(99.51);
    expect(queries.at(-1)).toContain('up{job="apisix"}');
    expect(indicators.manualStepsAvoided.total).toBeGreaterThanOrEqual(4);
    expect(indicators.manualStepsAvoided.useCases).toBeGreaterThanOrEqual(1);
  });

  it('the approval time is from the request to the provider decision of a person', async () => {
    const programas = await prisma.entity.findFirstOrThrow({
      where: { slug: 'programas-sociales' },
    });
    const application = await prisma.application.create({
      data: {
        entityId: programas.id,
        name: `Indicadores ${run}`,
        description: 'Aplicación de prueba.',
        environment: 'production',
        keycloakClientId: `den-app-test-${randomUUID()}`,
        technicalContact: 'dev@example.org',
        createdBy: 'test',
      },
    });
    const version = await prisma.apiVersion.findFirstOrThrow({ where: { apiId } });
    const subscription = await prisma.subscription.create({
      data: {
        applicationId: application.id,
        apiVersionId: version.id,
        purposeCode: 'eligibility_check',
        purposeDetail: 'Prueba de indicadores.',
        legalBasisText: 'Prueba.',
        requestedValidityMonths: 3,
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 90 * 24 * 3_600_000),
        requestedBy: (await prisma.user.findFirstOrThrow()).id,
        createdBy: 'test',
        // Requested six hours ago, decided now.
        createdAt: new Date(Date.now() - 6 * 3_600_000),
      },
    });
    await prisma.$transaction((tx) =>
      audit.record(tx, {
        actor: { type: 'user', id: sub('lucia.datos') },
        action: 'subscription.approved',
        target: { type: 'subscription', id: subscription.id },
      }),
    );
    const today = localDay(new Date(), loadCountryConfig({ code: 'co' }).country.timezone);
    const res = await get(`/network/indicators?from=${today}&to=${today}`, 'ana.operadora');
    const { approvalTime } = networkIndicatorsSchema.parse(res.json());
    expect(approvalTime.decisions).toBeGreaterThanOrEqual(1);
    expect(approvalTime.medianHours).not.toBeNull();
  });

  it('maps who exchanges with whom: calls, and active subscriptions without calls (M5-05)', async () => {
    const socioeconomico = await prisma.entity.findFirstOrThrow({
      where: { slug: 'socioeconomico' },
    });
    const application = await prisma.application.create({
      data: {
        entityId: socioeconomico.id,
        name: `Mapa ${run}`,
        description: 'Aplicación de prueba.',
        environment: 'production',
        keycloakClientId: `den-app-test-${randomUUID()}`,
        technicalContact: 'dev@example.org',
        createdBy: 'test',
      },
    });
    const version = await prisma.apiVersion.findFirstOrThrow({ where: { apiId } });
    await prisma.subscription.create({
      data: {
        applicationId: application.id,
        apiVersionId: version.id,
        purposeCode: 'eligibility_check',
        purposeDetail: 'Prueba del mapa.',
        legalBasisText: 'Prueba.',
        requestedValidityMonths: 3,
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 90 * 24 * 3_600_000),
        status: 'active',
        requestedBy: (await prisma.user.findFirstOrThrow()).id,
        createdBy: 'test',
      },
    });

    const res = await get('/network/exchanges?from=2025-06-01&to=2025-06-30', 'marta.regulador');
    expect(res.statusCode, res.body).toBe(200);
    const map = exchangeMapSchema.parse(res.json());
    const toMine = map.exchanges.filter((e) => e.providerId === entityId);
    // Every production call of programas-sociales, refused ones included; not the sandbox's.
    expect(toMine.find((e) => e.consumerName.match(/Programas/))).toMatchObject({
      calls: 6,
      errors: 3,
    });
    // An agreed exchange with no calls yet.
    expect(toMine.find((e) => e.consumerId === socioeconomico.id)).toMatchObject({
      calls: 0,
      activeSubscriptions: 1,
    });
    expect((await get('/network/exchanges', 'carlos.dev')).statusCode).toBe(403);
  });

  it('only the regulator and the operator see them', async () => {
    for (const username of ['carlos.dev', 'lucia.datos', 'pedro.publicador']) {
      expect((await get('/network/indicators', username)).statusCode, username).toBe(403);
    }
  });
});
