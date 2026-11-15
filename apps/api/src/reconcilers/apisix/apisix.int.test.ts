import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../../test/test-auth.js';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { readRealmUsers } from '../../seed/realm.js';
import { runSeed } from '../../seed/seed.js';
import { deleteUpstreamWhenUnused, HttpApisixAdmin } from './apisix-admin.js';
import { APISIX_SETTINGS, ApisixReconciler, gatewaySyncTarget } from './apisix.reconciler.js';
import { type GatewaySettings, parseDevNodes, routeId, upstreamId } from './desired-state.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

/**
 * Against the real APISIX Admin API (pnpm infra:up locally; etcd + apisix in CI). The reconciler
 * owns every `rid-` object: these tests create, break and repair them.
 */
describe('APISIX reconciler (M1-08)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  const settings: GatewaySettings = {
    keycloakDiscoveryUrl:
      'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
    audience: 'rid-gateway',
    opaUrl: 'http://opa:8181',
    accessLogUrl: 'http://fluent-bit:9880/',
    transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
    // socioeconomico has no node on purpose: its versions cannot be served.
    devNodes: parseDevNodes('salud=mock-salud:8000'),
    // A fake DNS the tests steer (an Error means the lookup fails).
    resolveHost: () => (dns instanceof Error ? Promise.reject(dns) : Promise.resolve(dns)),
    tls: { hosts: ['localhost'], mtlsRequired: false },
  };
  let dns: string[] | Error = ['93.184.215.14'];
  const created: string[] = [];
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let reconciler: ApisixReconciler;

  const call = async (url: string, username: string, payload?: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(subOf(username))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** pedro registers and submits a version; ana approves it (published, gateway.sync queued). */
  async function publish(entitySlug: string, slug: string): Promise<string> {
    const entity = await prisma.entity.findFirstOrThrow({ where: { slug: entitySlug } });
    const api = await call(`/entities/${entity.id}/apis`, 'pedro.publicador', {
      slug,
      name: `Gateway ${slug}`,
      summary: 'API para probar el reconciliador de APISIX.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      tags: [],
      classification: 'personal',
      ownerContact: 'apis@salud.demo.rid.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const version = await call(
      `/entities/${entity.id}/apis/${apiId}/versions`,
      'pedro.publicador',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: `/${entitySlug}` },
        allowedPurposes: ['eligibility_check'],
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
      },
    );
    const versionId = version.json<{ id: string }>().id;
    await call(
      `/entities/${entity.id}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    const approved = await call(`/review/api-versions/${versionId}/approve`, 'ana.operadora', {});
    expect(approved.statusCode, approved.body).toBe(200);
    created.push(versionId);
    return versionId;
  }

  beforeAll(async () => {
    await admin.list('routes').catch((error: unknown) => {
      throw new Error(`APISIX Admin API is not reachable (pnpm infra:up): ${String(error)}`);
    });
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [{ token: APISIX_SETTINGS, value: settings }]);
    reconciler = app.get(ApisixReconciler);
  });

  afterAll(async () => {
    // The full pass also served every published version of the test database. Locally APISIX is
    // shared with the development database, so remove everything this suite may have created.
    const served = await prisma.apiVersion.findMany({ select: { id: true } });
    const ids = [...new Set([...created, ...served.map((v) => v.id)])];
    // Routes first; upstreams once APISIX no longer sees them in use.
    for (const id of ids) await admin.delete('routes', routeId(id));
    for (const id of ids) await deleteUpstreamWhenUnused(admin, upstreamId(id));
    await app.close();
    await prisma.$disconnect();
  });

  it('publishing queues the sync; reconciling creates upstream and route once', async () => {
    const versionId = await publish('salud', `gw-${run}`);
    expect(
      await prisma.outboxMessage.count({
        where: { topic: 'gateway.sync', aggregate: `apiVersion:${versionId}` },
      }),
    ).toBe(1);

    expect(await reconciler.reconcileVersion(versionId)).toBe('created');
    const route = await admin.get('routes', routeId(versionId));
    expect(route).toMatchObject({
      uri: `/salud/gw-${run}/v1/*`,
      methods: ['GET', 'POST'],
      upstream_id: upstreamId(versionId),
    });
    expect(Object.keys(route?.plugins as object)).toEqual(
      expect.arrayContaining(['openid-connect', 'opa', 'proxy-rewrite', 'request-id']),
    );
    expect(await admin.get('upstreams', upstreamId(versionId))).toMatchObject({
      nodes: { 'mock-salud:8000': 1 },
    });
    expect(
      await prisma.syncState.findUnique({ where: { target: gatewaySyncTarget(versionId) } }),
    ).toMatchObject({ system: 'apisix', status: 'in_sync', lastError: null });

    // Idempotent: nothing to write the second time (defaults APISIX adds are not drift).
    expect(await reconciler.reconcileVersion(versionId)).toBe('unchanged');
  });

  it('the full pass recreates a route deleted by hand and repairs a tampered one', async () => {
    const versionId = await publish('salud', `gw-drift-${run}`);
    await reconciler.reconcileVersion(versionId);

    await admin.delete('routes', routeId(versionId));
    expect(await admin.get('routes', routeId(versionId))).toBeUndefined();
    await reconciler.reconcileAll();
    expect(await admin.get('routes', routeId(versionId))).toMatchObject({
      uri: `/salud/gw-drift-${run}/v1/*`,
    });

    // Someone removes the OPA plugin by hand: the next pass puts it back.
    const tampered = (await admin.get('routes', routeId(versionId))) ?? {};
    const { opa: _removed, ...plugins } = tampered.plugins as Record<string, unknown>;
    await admin.put('routes', routeId(versionId), { ...tampered, plugins });
    expect(await reconciler.reconcileVersion(versionId)).toBe('updated');
    expect((await admin.get('routes', routeId(versionId)))?.plugins).toHaveProperty('opa');
  });

  it('removes managed orphans and never touches objects it does not own', async () => {
    const orphan = randomUUID();
    const foreign = `test-foreign-${run}`;
    await admin.put('upstreams', upstreamId(orphan), {
      type: 'roundrobin',
      nodes: { 'mock-salud:8000': 1 },
    });
    await admin.put('routes', routeId(orphan), {
      uri: `/orphan-${run}/*`,
      upstream_id: upstreamId(orphan),
    });
    await admin.put('routes', foreign, {
      uri: `/foreign-${run}/*`,
      upstream_id: upstreamId(orphan),
    });
    try {
      await reconciler.reconcileAll();
      expect(await admin.get('routes', routeId(orphan))).toBeUndefined();
      expect(await admin.get('routes', foreign)).toBeDefined();
    } finally {
      await admin.delete('routes', foreign);
      await admin.delete('upstreams', upstreamId(orphan));
    }
  });

  it('a version the gateway cannot serve is recorded as an error and nothing is written', async () => {
    const versionId = await publish('socioeconomico', `gw-nonode-${run}`);
    await expect(reconciler.reconcileVersion(versionId)).rejects.toThrow(/RID_DEV_NODES/);
    expect(await admin.get('routes', routeId(versionId))).toBeUndefined();
    expect(await admin.get('upstreams', upstreamId(versionId))).toBeUndefined();
    const state = await prisma.syncState.findUnique({
      where: { target: gatewaySyncTarget(versionId) },
    });
    expect(state?.status).toBe('error');
    expect(state?.lastError).toMatch(/socioeconomico/);
  });

  describe('SSRF guard at reconcile time (security review)', () => {
    const setUpstream = (versionId: string, upstream: unknown) =>
      prisma.apiVersion.update({
        where: { id: versionId },
        data: { upstream: upstream as object },
      });

    it('a served version whose stored upstream is internal loses its route (fail closed)', async () => {
      const versionId = await publish('salud', `gw-legacy-${run}`);
      expect(await reconciler.reconcileVersion(versionId)).toBe('created');
      // A row written before the registration check existed.
      await setUpstream(versionId, {
        type: 'direct',
        url: 'https://keycloak:8443/admin',
        mtls: false,
      });
      await expect(reconciler.reconcileVersion(versionId)).rejects.toThrow();
      expect(await admin.get('routes', routeId(versionId))).toBeUndefined();
      expect(await admin.get('upstreams', upstreamId(versionId))).toBeUndefined();
      const state = await prisma.syncState.findUnique({
        where: { target: gatewaySyncTarget(versionId) },
      });
      expect(state?.status).toBe('error');
    });

    it('a public IPv6 literal is served without a DNS lookup', async () => {
      const versionId = await publish('salud', `gw-ipv6-${run}`);
      await setUpstream(versionId, {
        type: 'direct',
        url: 'https://[2001:4860:4860::8888]/v1',
        mtls: false,
      });
      try {
        dns = new Error('a literal address must not be looked up');
        expect(await reconciler.reconcileVersion(versionId)).toBe('created');
      } finally {
        dns = ['93.184.215.14'];
      }
    });

    it('a public name that resolves to a private address is not served', async () => {
      const versionId = await publish('salud', `gw-dns-${run}`);
      await setUpstream(versionId, {
        type: 'direct',
        url: 'https://api.salud.example/v1',
        mtls: false,
      });
      try {
        dns = ['93.184.215.14'];
        expect(await reconciler.reconcileVersion(versionId)).toBe('created');
        expect(await admin.get('upstreams', upstreamId(versionId))).toMatchObject({
          nodes: { 'api.salud.example:443': 1 },
        });

        // A DNS failure is reported, but a working route stays.
        dns = new Error('getaddrinfo ENOTFOUND');
        await expect(reconciler.reconcileVersion(versionId)).rejects.toThrow(/ENOTFOUND/);
        expect(await admin.get('routes', routeId(versionId))).toBeDefined();

        // The name now points inside the network: the route goes away.
        dns = ['93.184.215.14', '10.0.0.5'];
        await expect(reconciler.reconcileVersion(versionId)).rejects.toThrow(/non-public/);
        expect(await admin.get('routes', routeId(versionId))).toBeUndefined();
        expect(await admin.get('upstreams', upstreamId(versionId))).toBeUndefined();
      } finally {
        dns = ['93.184.215.14'];
      }
    });
  });

  it('a retired version loses its route and upstream', async () => {
    const versionId = await publish('salud', `gw-retired-${run}`);
    await reconciler.reconcileVersion(versionId);
    // Retirement arrives with M2-05; the fixture sets the status directly.
    await prisma.apiVersion.update({ where: { id: versionId }, data: { status: 'retired' } });
    expect(await reconciler.reconcileVersion(versionId)).toBe('deleted');
    expect(await admin.get('routes', routeId(versionId))).toBeUndefined();
    expect(await admin.get('upstreams', upstreamId(versionId))).toBeUndefined();
    expect(await reconciler.reconcileVersion(versionId)).toBe('absent');
  });
});
