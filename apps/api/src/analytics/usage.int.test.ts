import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { consumedUsageSchema, providerUsageSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { routeId, sandboxRouteId } from '../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { AccessLogIndexReconciler } from './access-log-index.js';
import { HttpOpenSearch, OPENSEARCH, openSearchUrl } from './opensearch.js';

/**
 * Usage of an entity's APIs (M5-02), against PostgreSQL and the real OpenSearch with the access-log
 * template. Documents shaped as Fluent Bit writes them go into an index of their own, for versions
 * created here: other runs' or the stack's logs never match their routes.
 */
describe("usage of an entity's APIs (M5-02)", () => {
  const prisma = new PrismaService();
  const openSearch = new HttpOpenSearch(openSearchUrl());
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 8);
  const index = `den-access-test-usage-${run}`;
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let socioeconomico = '';
  let apiId = '';
  let otherApiId = '';
  let versionId = '';
  let otherVersionId = '';

  async function api(entityId: string, slug: string) {
    const created = await prisma.api.create({
      data: {
        entityId,
        slug,
        name: `Uso ${slug}`,
        summary: 'API de prueba de la analítica de uso.',
        description: 'API de prueba.',
        sector: 'salud',
        classification: 'personal',
        ownerContact: 'apis@example.org',
        status: 'published',
        createdBy: 'test',
      },
    });
    const version = await prisma.apiVersion.create({
      data: {
        apiId: created.id,
        version: '1.0',
        major: 1,
        minor: 0,
        status: 'published',
        openapiSpec: {},
        openapiSha256: '0'.repeat(64),
        upstreamType: 'node',
        upstream: { type: 'node', servicePath: '/salud' },
        basePath: `/test/${slug}/v1`,
        createdBy: 'test',
      },
    });
    return { apiId: created.id, versionId: version.id };
  }

  /** One access-log document as allowlist.lua leaves it. */
  const doc = (route: string, ts: string, fields: Record<string, unknown>) => ({
    ts,
    request_id: randomUUID(),
    route_id: route,
    method: 'GET',
    gateway_node: 'apisix-test',
    bytes_sent: 300,
    ...fields,
  });

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    socioeconomico = (await prisma.entity.findFirstOrThrow({ where: { slug: 'socioeconomico' } }))
      .id;
    ({ apiId, versionId } = await api(salud, `uso-${run}`));
    ({ apiId: otherApiId, versionId: otherVersionId } = await api(
      socioeconomico,
      `uso-otra-${run}`,
    ));
    await new AccessLogIndexReconciler(prisma, openSearch).reconcileTemplate();

    const route = routeId(versionId);
    const ok = { status: 200, operation: 'getAfiliado', purpose: 'eligibility_check' };
    const docs = [
      // 2026-03-02 (Bogotá): three calls of programas-sociales, one of them a provider error.
      doc(route, '2026-03-02T14:00:00Z', {
        ...ok,
        consumer_entity: 'programas-sociales',
        latency_ms: 10,
        upstream_latency_ms: 8,
      }),
      doc(route, '2026-03-02T15:00:00Z', {
        ...ok,
        consumer_entity: 'programas-sociales',
        latency_ms: 20,
        upstream_latency_ms: 18,
      }),
      doc(route, '2026-03-02T16:00:00Z', {
        ...ok,
        status: 502,
        consumer_entity: 'programas-sociales',
        latency_ms: 30,
      }),
      // 23:30 in Bogotá is already the 3rd in UTC: it counts on the 2nd.
      doc(route, '2026-03-03T04:30:00Z', {
        ...ok,
        consumer_entity: 'programas-sociales',
        latency_ms: 40,
        upstream_latency_ms: 35,
      }),
      // 2026-03-03: a denial with its reason, and a call nobody could be attributed to (401).
      doc(route, '2026-03-03T13:00:00Z', {
        status: 403,
        purpose: 'benefit_targeting',
        consumer_entity: 'programas-sociales',
        deny_reason: 'purpose_not_allowed',
        latency_ms: 2,
      }),
      doc(route, '2026-03-03T14:00:00Z', { status: 401, latency_ms: 1 }),
      // Outside the period.
      doc(route, '2026-02-20T14:00:00Z', {
        ...ok,
        consumer_entity: 'programas-sociales',
        latency_ms: 5,
      }),
      // The sandbox of the version.
      doc(sandboxRouteId(versionId), '2026-03-02T14:00:00Z', {
        ...ok,
        consumer_entity: 'programas-sociales',
        latency_ms: 5,
      }),
      // Another entity's API.
      doc(routeId(otherVersionId), '2026-03-02T14:00:00Z', {
        ...ok,
        consumer_entity: 'programas-sociales',
        latency_ms: 5,
      }),
    ];
    const bulk =
      docs
        .flatMap((d) => [JSON.stringify({ index: { _index: index } }), JSON.stringify(d)])
        .join('\n') + '\n';
    const res = await fetch(`${openSearchUrl()}/_bulk?refresh=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: bulk,
    });
    const result = (await res.json()) as { errors: boolean };
    expect(result.errors).toBe(false);

    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
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

  const period = 'from=2026-03-02&to=2026-03-03';

  it('counts the calls of the period by consumer, purpose, operation and answer', async () => {
    const res = await get(
      `/entities/${salud}/usage/provided?${period}&apiId=${apiId}`,
      'lucia.datos',
    );
    expect(res.statusCode, res.body).toBe(200);
    const usage = providerUsageSchema.parse(res.json());
    expect(usage.period).toEqual({
      from: '2026-03-02',
      to: '2026-03-03',
      timeZone: 'America/Bogota',
    });
    expect(usage.environment).toBe('production');
    expect(usage.totals).toMatchObject({
      calls: 6,
      ok: 3,
      denied: 1,
      clientErrors: 1,
      serverErrors: 1,
    });
    expect(usage.totals.latencyP95Ms).toBeGreaterThan(usage.totals.latencyP50Ms ?? 0);
    // Local days: the call at 23:30 in Bogotá belongs to the 2nd.
    expect(usage.daily).toEqual([
      { date: '2026-03-02', calls: 4, errors: 1 },
      { date: '2026-03-03', calls: 2, errors: 2 },
    ]);
    expect(usage.byConsumer).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityName: expect.stringMatching(/Programas/) as unknown,
          calls: 5,
          errors: 2,
        }),
        // The 401: the gateway could not tell who called.
        { entityId: null, entityName: null, calls: 1, errors: 1 },
      ]),
    );
    const eligibility = usage.byPurpose.find((p) => p.code === 'eligibility_check');
    expect(eligibility?.calls).toBe(4);
    expect(eligibility?.name).toBeTruthy();
    expect(usage.byPurpose.find((p) => p.code === 'benefit_targeting')?.calls).toBe(1);
    expect(usage.byOperation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiId,
          version: '1.0',
          operation: 'getAfiliado',
          calls: 4,
          errors: 1,
        }),
      ]),
    );
    expect(usage.byStatus).toEqual([
      { status: 200, calls: 3 },
      { status: 401, calls: 1 },
      { status: 403, calls: 1 },
      { status: 502, calls: 1 },
    ]);
  });

  it('the sandbox traffic is apart from the real one', async () => {
    const res = await get(
      `/entities/${salud}/usage/provided?${period}&apiId=${apiId}&environment=sandbox`,
      'pedro.publicador',
    );
    expect(providerUsageSchema.parse(res.json()).totals.calls).toBe(1);
  });

  it("an entity never sees the calls to another entity's APIs", async () => {
    // Salud's usage has no call to socioeconomico's API.
    const all = providerUsageSchema.parse(
      (await get(`/entities/${salud}/usage/provided?${period}`, 'lucia.datos')).json(),
    );
    expect(all.byOperation.map((o) => o.apiId)).not.toContain(otherApiId);
    // An API of another entity is not found through this one.
    const other = await get(
      `/entities/${salud}/usage/provided?${period}&apiId=${otherApiId}`,
      'lucia.datos',
    );
    expect(other.statusCode).toBe(404);
    // A member of another entity does not find salud.
    expect(
      (await get(`/entities/${salud}/usage/provided?${period}`, 'carlos.dev')).statusCode,
    ).toBe(404);
  });

  it('the regulator and the operator see any entity', async () => {
    for (const username of ['marta.regulador', 'ana.operadora']) {
      const res = await get(`/entities/${salud}/usage/provided?${period}&apiId=${apiId}`, username);
      expect(res.statusCode, username).toBe(200);
    }
  });

  it('rejects a period longer than a year or the wrong way round', async () => {
    for (const query of ['from=2025-01-01&to=2026-03-03', 'from=2026-03-04&to=2026-03-03']) {
      const res = await get(`/entities/${salud}/usage/provided?${query}`, 'lucia.datos');
      expect(res.statusCode, query).toBe(400);
    }
  });

  it('answers 503 when the analytics store is down', async () => {
    const down = await createTestApp(issuer, [
      { token: OPENSEARCH, value: new HttpOpenSearch('http://127.0.0.1:1', undefined, 500) },
    ]);
    try {
      const res = await down.inject({
        method: 'GET',
        url: `/api/v1/entities/${salud}/usage/provided?${period}`,
        headers: { authorization: `Bearer ${await issuer.token(sub('lucia.datos'))}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('application/problem+json');
    } finally {
      await down.close();
    }
  });
});

/**
 * Usage of an entity's applications (M5-03): their calls by application and API, and the gateway's
 * refusals with their reason. Same store and template as above.
 */
describe("usage of an entity's applications (M5-03)", () => {
  const prisma = new PrismaService();
  const openSearch = new HttpOpenSearch(openSearchUrl());
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 8);
  const index = `den-access-test-consumed-${run}`;
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let programas = '';
  let salud = '';
  let versionId = '';
  const apps: Record<'prod' | 'sandbox' | 'other', { id: string; clientId: string }> = {
    prod: { id: '', clientId: '' },
    sandbox: { id: '', clientId: '' },
    other: { id: '', clientId: '' },
  };

  async function application(entityId: string, environment: 'production' | 'sandbox') {
    const clientId = `den-app-test-${randomUUID()}`;
    const row = await prisma.application.create({
      data: {
        entityId,
        name: `Consumo ${environment} ${run}`,
        description: 'Aplicación de prueba del uso.',
        environment,
        keycloakClientId: clientId,
        technicalContact: 'dev@example.org',
        createdBy: 'test',
      },
    });
    return { id: row.id, clientId };
  }

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    const socioeconomico = (
      await prisma.entity.findFirstOrThrow({ where: { slug: 'socioeconomico' } })
    ).id;
    apps.prod = await application(programas, 'production');
    apps.sandbox = await application(programas, 'sandbox');
    apps.other = await application(socioeconomico, 'production');
    const api = await prisma.api.create({
      data: {
        entityId: salud,
        slug: `consumo-${run}`,
        name: `Consumo ${run}`,
        summary: 'API de prueba del uso de consumidores.',
        description: 'API de prueba.',
        sector: 'salud',
        classification: 'personal',
        ownerContact: 'apis@example.org',
        status: 'published',
        createdBy: 'test',
      },
    });
    versionId = (
      await prisma.apiVersion.create({
        data: {
          apiId: api.id,
          version: '2.1',
          major: 2,
          minor: 1,
          status: 'published',
          openapiSpec: {},
          openapiSha256: '0'.repeat(64),
          upstreamType: 'node',
          upstream: { type: 'node', servicePath: '/salud' },
          basePath: `/test/consumo-${run}/v2`,
          createdBy: 'test',
        },
      })
    ).id;
    await new AccessLogIndexReconciler(prisma, openSearch).reconcileTemplate();

    const base = {
      method: 'GET',
      gateway_node: 'apisix-test',
      consumer_entity: 'programas-sociales',
    };
    const docs = [
      {
        route_id: routeId(versionId),
        status: 200,
        consumer_app: apps.prod.clientId,
        latency_ms: 10,
      },
      {
        route_id: routeId(versionId),
        status: 200,
        consumer_app: apps.prod.clientId,
        latency_ms: 30,
      },
      {
        route_id: routeId(versionId),
        status: 403,
        consumer_app: apps.prod.clientId,
        deny_reason: 'purpose_not_allowed',
        latency_ms: 2,
      },
      {
        route_id: routeId(versionId),
        status: 429,
        consumer_app: apps.prod.clientId,
        deny_reason: 'rate_limited',
        latency_ms: 1,
      },
      // The sandbox app on the version's sandbox; one refusal for the wrong environment.
      {
        route_id: sandboxRouteId(versionId),
        status: 200,
        consumer_app: apps.sandbox.clientId,
        latency_ms: 5,
      },
      {
        route_id: routeId(versionId),
        status: 403,
        consumer_app: apps.sandbox.clientId,
        deny_reason: 'environment_mismatch',
        latency_ms: 1,
      },
      // Another entity's application.
      {
        route_id: routeId(versionId),
        status: 200,
        consumer_app: apps.other.clientId,
        latency_ms: 5,
      },
    ];
    const bulk =
      docs
        .flatMap((d) => [
          JSON.stringify({ index: { _index: index } }),
          JSON.stringify({ ...base, ...d, ts: '2026-04-10T15:00:00Z', request_id: randomUUID() }),
        ])
        .join('\n') + '\n';
    const res = await fetch(`${openSearchUrl()}/_bulk?refresh=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: bulk,
    });
    expect(((await res.json()) as { errors: boolean }).errors).toBe(false);
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
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
  const period = 'from=2026-04-10&to=2026-04-10';

  it("counts the calls of the entity's applications by application and API", async () => {
    const res = await get(`/entities/${programas}/usage/consumed?${period}`, 'carlos.dev');
    expect(res.statusCode, res.body).toBe(200);
    const usage = consumedUsageSchema.parse(res.json());
    // Six calls of its two applications; the other entity's call is not here.
    expect(usage.totals).toMatchObject({ calls: 6, ok: 3, denied: 3 });
    const prod = usage.byApplication.find((a) => a.applicationId === apps.prod.id);
    expect(prod).toMatchObject({ environment: 'production', calls: 4, errors: 2, denied: 2 });
    expect(usage.byApplication.find((a) => a.applicationId === apps.sandbox.id)).toMatchObject({
      environment: 'sandbox',
      calls: 2,
    });
    expect(usage.byApplication.map((a) => a.applicationId)).not.toContain(apps.other.id);
    expect(usage.byApi).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiName: `Consumo ${run}`,
          version: '2.1',
          providerName: expect.stringMatching(/Salud/) as unknown,
          sandbox: false,
          calls: 5,
        }),
        expect.objectContaining({ sandbox: true, calls: 1 }),
      ]),
    );
  });

  it('lists the refusals with their reason, per application', async () => {
    const usage = consumedUsageSchema.parse(
      (await get(`/entities/${programas}/usage/consumed?${period}`, 'carlos.dev')).json(),
    );
    expect(usage.denials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'purpose_not_allowed',
          applicationId: apps.prod.id,
          calls: 1,
        }),
        expect.objectContaining({ reason: 'rate_limited', applicationId: apps.prod.id, calls: 1 }),
        expect.objectContaining({
          reason: 'environment_mismatch',
          applicationId: apps.sandbox.id,
          calls: 1,
        }),
      ]),
    );
  });

  it('one application at a time; never one of another entity', async () => {
    const one = consumedUsageSchema.parse(
      (
        await get(
          `/entities/${programas}/usage/consumed?${period}&applicationId=${apps.sandbox.id}`,
          'carlos.dev',
        )
      ).json(),
    );
    expect(one.totals.calls).toBe(2);
    const other = await get(
      `/entities/${programas}/usage/consumed?${period}&applicationId=${apps.other.id}`,
      'carlos.dev',
    );
    expect(other.statusCode).toBe(404);
    // A member of another entity does not find programas-sociales.
    expect(
      (await get(`/entities/${programas}/usage/consumed?${period}`, 'lucia.datos')).statusCode,
    ).toBe(404);
  });
});
