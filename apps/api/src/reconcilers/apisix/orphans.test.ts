import { describe, expect, it } from 'vitest';
import type { GatewaySigningKeysService } from '../../assertion/gateway-signing-keys.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { QueueService } from '../../queue/queue.service.js';
import type { ApisixAdmin, ApisixKind } from './apisix-admin.js';
import { ApisixReconciler } from './apisix.reconciler.js';
import {
  GATEWAY_SSL_ID,
  GATEWAY_XROAD_SSL_ID,
  type GatewaySettings,
  gatewayClientSslId,
  parseDevNodes,
  routeId,
  upstreamId,
} from './desired-state.js';
import type { GatewayCertificates } from './gateway-certificates.js';

const VERSION = '0190d0c4-0000-7000-8000-0000000000aa';
const ENTITY = '0190d0c4-0000-7000-8000-0000000000e1';
const OTHER_ENTITY = '0190d0c4-0000-7000-8000-0000000000e2';

class MemoryApisix implements ApisixAdmin {
  readonly objects = new Map<string, Record<string, unknown>>();
  readonly deleted: string[] = [];
  get(kind: ApisixKind, id: string) {
    return Promise.resolve(this.objects.get(`${kind}/${id}`));
  }
  put(kind: ApisixKind, id: string, value: Record<string, unknown>) {
    this.objects.set(`${kind}/${id}`, structuredClone(value));
    return Promise.resolve();
  }
  delete(kind: ApisixKind, id: string) {
    this.deleted.push(`${kind}/${id}`);
    this.objects.delete(`${kind}/${id}`);
    return Promise.resolve();
  }
  list(kind: ApisixKind) {
    return Promise.resolve(
      [...this.objects.keys()]
        .filter((k) => k.startsWith(`${kind}/`))
        .map((k) => k.slice(kind.length + 1)),
    );
  }
}

const baseSettings: GatewaySettings = {
  keycloakDiscoveryUrl: 'http://keycloak:8080/realms/den-gateway/.well-known/openid-configuration',
  audience: 'den-gateway',
  opaUrl: 'http://opa:8181',
  accessLogUrl: 'http://fluent-bit:9880/',
  transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
  devNodes: parseDevNodes(''),
  resolveHost: () => Promise.resolve(['93.184.215.14']),
  tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'den-gateway' },
};

const CERT = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
let serverCertificates = 0;
const certificates = {
  server: (hosts: string[]) => {
    serverCertificates += 1;
    return Promise.resolve({
      id: 'c1',
      hosts,
      certificatePem: CERT,
      keyPem: 'key',
      networkCaPem: CERT,
      fingerprint: 'fp-server',
      notAfter: new Date(Date.now() + 1e9),
    });
  },
  upstreamClient: (name: string) =>
    Promise.resolve({
      id: `c-${name}`,
      hosts: [name],
      certificatePem: CERT,
      keyPem: 'key',
      networkCaPem: CERT,
      fingerprint: `fp-${name}`,
      notAfter: new Date(Date.now() + 1e9),
    }),
} as unknown as GatewayCertificates;

const spec = { paths: { '/hogares/{id}': { get: { operationId: 'getHogar' } } } };

const entity = {
  id: ENTITY,
  slug: 'social',
  xroadMemberClass: 'GOV',
  xroadMemberCode: '8999999999',
};

function versionRow(overrides: Record<string, unknown>) {
  return {
    id: VERSION,
    status: 'published',
    basePath: '/social/hogares/v1',
    version: '1.0',
    openapiSpec: spec,
    sandboxUpstream: null,
    deprecatedAt: null,
    sunsetAt: null,
    api: { name: 'Hogares', entityId: ENTITY, entity },
    ...overrides,
  };
}

const statusMatches = (filter: unknown, status: string) =>
  typeof filter === 'string'
    ? filter === status
    : ((filter as { in?: string[] } | undefined)?.in?.includes(status) ?? true);

/**
 * Prisma stub with one version: `row` is what a read by id returns now. With `listed: false`, the
 * pass's listings (findMany) miss it, as a listing taken before its publication committed would.
 * `locks` counts the advisory locks taken (one per unit of work).
 */
function prismaWith(row: ReturnType<typeof versionRow> | null, { listed = true } = {}) {
  const counters = { locks: 0 };
  const prisma = {
    $transaction: (work: (tx: unknown) => Promise<unknown>) => work(prisma),
    $executeRaw: () => {
      counters.locks += 1;
      return Promise.resolve(1);
    },
    apiVersion: {
      findUnique: () => Promise.resolve(row),
      findMany: (args: { where: { status: unknown } }) =>
        Promise.resolve(listed && row && statusMatches(args.where.status, row.status) ? [row] : []),
    },
    node: { findUnique: () => Promise.resolve(null) },
    syncState: { upsert: () => Promise.resolve({}), findUnique: () => Promise.resolve(null) },
  };
  return { prisma: prisma as unknown as PrismaService, counters };
}

const reconciler = (prisma: PrismaService, admin: ApisixAdmin, settings: GatewaySettings) =>
  new ApisixReconciler(
    prisma,
    {} as QueueService,
    admin,
    settings,
    certificates,
    {} as GatewaySigningKeysService,
  );

describe('APISIX reconciler: the full pass keeps what served routes depend on', () => {
  it('keeps the X-Road client certificate (den-ssl-gateway-xroad) that an xroad upstream references (A-5)', async () => {
    const admin = new MemoryApisix();
    const settings: GatewaySettings = {
      ...baseSettings,
      xroad: { securityServerUrl: 'https://ss.and.example:8443', client: 'CO/GOV/1/DEN' },
    };
    const row = versionRow({
      upstream: {
        type: 'xroad',
        serviceId: {
          instance: 'CO',
          memberClass: 'GOV',
          memberCode: '8999999999',
          serviceCode: 'consultaHogar',
        },
        servicePath: '',
      },
    });
    await reconciler(prismaWith(row).prisma, admin, settings).reconcileAll();

    const upstream = admin.objects.get(`upstreams/${upstreamId(VERSION)}`) as {
      tls?: { client_cert_id?: string };
    };
    expect(upstream?.tls?.client_cert_id).toBe(GATEWAY_XROAD_SSL_ID);
    // The upstream references it, so after the pass it must still exist.
    expect(admin.deleted).not.toContain(`ssls/${GATEWAY_XROAD_SSL_ID}`);
    expect(admin.objects.has(`ssls/${GATEWAY_XROAD_SSL_ID}`)).toBe(true);
  });

  it('keeps the client certificate of a provider whose only version is in review (M-10)', async () => {
    const admin = new MemoryApisix();
    const settings: GatewaySettings = { ...baseSettings, validationToken: 'validation-token' };
    const row = versionRow({
      status: 'in_review',
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: true },
    });
    await reconciler(prismaWith(row).prisma, admin, settings).reconcileAll();

    const check = admin.objects.get(`routes/den-check-${VERSION}`) as {
      upstream?: { tls?: { client_cert_id?: string } };
    };
    expect(check?.upstream?.tls?.client_cert_id).toBe(gatewayClientSslId(ENTITY));
    expect(admin.objects.has(`ssls/${gatewayClientSslId(ENTITY)}`)).toBe(true);
  });

  it('does not delete the route of a version published while the pass was running (M-09)', async () => {
    const admin = new MemoryApisix();
    const row = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: false },
    });
    // The pass listed the served versions before the publication committed (empty listing);
    // the outbox job of the publication then created the route; the database says published.
    const { prisma } = prismaWith(row, { listed: false });
    const r = reconciler(prisma, admin, baseSettings);
    await r.reconcileVersion(VERSION);
    expect(admin.objects.has(`routes/${routeId(VERSION)}`)).toBe(true);

    await r.reconcileAll();
    expect(admin.objects.has(`routes/${routeId(VERSION)}`)).toBe(true);
    expect(admin.objects.has(`upstreams/${upstreamId(VERSION)}`)).toBe(true);
  });

  it('deletes exactly the SSL objects nothing needs, and none it does not own', async () => {
    const admin = new MemoryApisix();
    const row = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: true },
    });
    const ssl = { type: 'client', cert: CERT, labels: { 'den-managed': 'true' }, status: 1 };
    // Another entity's identity, an X-Road one with no xroad version, one outside den-.
    await admin.put('ssls', gatewayClientSslId(OTHER_ENTITY), ssl);
    await admin.put('ssls', GATEWAY_XROAD_SSL_ID, ssl);
    await admin.put('ssls', 'operator-own-ssl', ssl);
    await reconciler(prismaWith(row).prisma, admin, baseSettings).reconcileAll();

    expect((await admin.list('ssls')).sort()).toEqual(
      [GATEWAY_SSL_ID, gatewayClientSslId(ENTITY), 'operator-own-ssl'].sort(),
    );
  });

  it('removes the client certificate of a provider whose versions no longer use mTLS', async () => {
    const admin = new MemoryApisix();
    const mtls = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: true },
    });
    await reconciler(prismaWith(mtls).prisma, admin, baseSettings).reconcileAll();
    expect(admin.objects.has(`ssls/${gatewayClientSslId(ENTITY)}`)).toBe(true);

    const plain = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: false },
    });
    await reconciler(prismaWith(plain).prisma, admin, baseSettings).reconcileAll();
    expect(admin.objects.has(`ssls/${gatewayClientSslId(ENTITY)}`)).toBe(false);
    expect((admin.objects.get(`upstreams/${upstreamId(VERSION)}`) as { tls?: object }).tls).toEqual(
      { verify: true },
    );
  });
});

describe('APISIX reconciler: units of work are serialized (M-09)', () => {
  it('takes the advisory lock once per unit; the units it calls keep it', async () => {
    const admin = new MemoryApisix();
    const row = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: true },
    });
    const { prisma, counters } = prismaWith(row);
    // One version with mTLS: its check routes and its client certificate are units of their own.
    await reconciler(prisma, admin, baseSettings).reconcileVersion(VERSION);
    expect(counters.locks).toBe(1);
  });

  it('a pass asked for while one runs waits for it and runs once more, not once per call', async () => {
    const admin = new MemoryApisix();
    const { prisma } = prismaWith(null);
    const r = reconciler(prisma, admin, baseSettings);
    serverCertificates = 0;
    const first = r.reconcileAll();
    const second = r.reconcileAll();
    const third = r.reconcileAll();
    await Promise.all([first, second, third]);
    expect(serverCertificates).toBe(2);
  });
});

describe('APISIX reconciler: converges to the desired state (M-08, ADR-0007)', () => {
  it('removes an upstream address the provider host no longer resolves to', async () => {
    const admin = new MemoryApisix();
    const row = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: false },
    });
    let addresses = ['93.184.215.14', '93.184.215.99'];
    const settings: GatewaySettings = {
      ...baseSettings,
      resolveHost: () => Promise.resolve(addresses),
    };
    const r = reconciler(prismaWith(row).prisma, admin, settings);
    await r.reconcileVersion(VERSION);
    expect(
      Object.keys(
        (admin.objects.get(`upstreams/${upstreamId(VERSION)}`) as { nodes: object }).nodes,
      ),
    ).toHaveLength(2);

    // The provider drops one address (it now belongs to someone else).
    addresses = ['93.184.215.14'];
    await r.reconcileVersion(VERSION);
    expect(
      Object.keys(
        (admin.objects.get(`upstreams/${upstreamId(VERSION)}`) as { nodes: object }).nodes,
      ),
    ).toEqual(['93.184.215.14:443']);
  });

  it('takes den-assertion off the routes when the country turns the assertion off', async () => {
    const admin = new MemoryApisix();
    const row = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: false },
    });
    const { prisma } = prismaWith(row);
    await reconciler(prisma, admin, {
      ...baseSettings,
      assertion: { issuer: 'https://gw.example' },
    }).reconcileVersion(VERSION);
    expect(
      (admin.objects.get(`routes/${routeId(VERSION)}`) as { plugins: object }).plugins,
    ).toHaveProperty('den-assertion');

    // Feature off: reconcileAssertionKey deletes the plugin metadata (the key); a route that
    // still carried den-assertion would answer 503 to every call (den-assertion.lua).
    const off = reconciler(prisma, admin, baseSettings);
    expect(await off.reconcileAssertionKey()).toBe('absent');
    await off.reconcileVersion(VERSION);
    expect(
      (admin.objects.get(`routes/${routeId(VERSION)}`) as { plugins: object }).plugins,
    ).not.toHaveProperty('den-assertion');
  });

  it('removes a plugin added to a managed route by hand (drift by addition)', async () => {
    const admin = new MemoryApisix();
    const row = versionRow({
      upstream: { type: 'direct', url: 'https://api.social.example/v1', mtls: false },
    });
    const r = reconciler(prismaWith(row).prisma, admin, baseSettings);
    await r.reconcileVersion(VERSION);
    // Someone with the Admin API adds a plugin by hand (or an earlier desired state had it).
    const route = admin.objects.get(`routes/${routeId(VERSION)}`) as {
      plugins: Record<string, unknown>;
    };
    route.plugins['serverless-pre-function'] = { phase: 'access', functions: ['return 1'] };

    expect(await r.reconcileVersion(VERSION)).toBe('updated');
    expect(
      (admin.objects.get(`routes/${routeId(VERSION)}`) as { plugins: object }).plugins,
    ).not.toHaveProperty('serverless-pre-function');
    expect(await r.reconcileVersion(VERSION)).toBe('unchanged');
  });
});
