import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { QueueService } from '../../queue/queue.service.js';
import { type ApisixAdmin, ApisixAdminError, type ApisixKind } from './apisix-admin.js';
import { ApisixReconciler } from './apisix.reconciler.js';
import { type GatewaySettings, parseDevNodes, routeId, upstreamId } from './desired-state.js';
import type { GatewaySigningKeysService } from '../../assertion/gateway-signing-keys.service.js';
import type { GatewayCertificates } from './gateway-certificates.js';

const VERSION = '0190d0c4-0000-7000-8000-0000000000aa';

/** APISIX whose config cache lags: an upstream delete fails `staleFor` times after the route's. */
class LaggingApisix implements ApisixAdmin {
  readonly objects = new Map<string, Record<string, unknown>>([
    [`routes/${routeId(VERSION)}`, { uri: '/x/*' }],
    [`upstreams/${upstreamId(VERSION)}`, { nodes: {} }],
  ]);
  attempts = 0;
  constructor(
    private staleFor: number,
    private readonly failure = 'still using it now',
  ) {}
  get(kind: ApisixKind, id: string) {
    return Promise.resolve(this.objects.get(`${kind}/${id}`));
  }
  put(kind: ApisixKind, id: string, value: Record<string, unknown>) {
    this.objects.set(`${kind}/${id}`, value);
    return Promise.resolve();
  }
  delete(kind: ApisixKind, id: string) {
    if (kind === 'upstreams') {
      this.attempts += 1;
      if (this.staleFor > 0) {
        this.staleFor -= 1;
        return Promise.reject(new ApisixAdminError(`APISIX DELETE failed: 400 ${this.failure}`));
      }
    }
    this.objects.delete(`${kind}/${id}`);
    return Promise.resolve();
  }
  list() {
    return Promise.resolve([]);
  }
}

const settings: GatewaySettings = {
  keycloakDiscoveryUrl: 'http://keycloak:8080/realms/den-gateway/.well-known/openid-configuration',
  audience: 'den-gateway',
  opaUrl: 'http://opa:8181',
  accessLogUrl: 'http://fluent-bit:9880/',
  transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
  devNodes: parseDevNodes(''),
  resolveHost: () => Promise.resolve([]),
  tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'den-gateway' },
};

/** Only what reconcileVersion touches for a retired version, and the advisory lock. */
const prismaStub = {
  $transaction: (work: (tx: unknown) => Promise<unknown>) => work(prismaStub),
  $executeRaw: () => Promise.resolve(1),
  apiVersion: { findUnique: () => Promise.resolve({ id: VERSION, status: 'retired' }) },
  syncState: { upsert: () => Promise.resolve({}) },
};
const prisma = prismaStub as unknown as PrismaService;

const reconciler = (admin: ApisixAdmin) =>
  new ApisixReconciler(
    prisma,
    {} as QueueService,
    admin,
    settings,
    {} as GatewayCertificates,
    {} as GatewaySigningKeysService,
  );

describe('APISIX reconciler: removing a version', () => {
  it('retries the upstream while APISIX still sees the deleted route', async () => {
    const admin = new LaggingApisix(2);
    expect(await reconciler(admin).reconcileVersion(VERSION)).toBe('deleted');
    expect(admin.attempts).toBe(3);
    expect(admin.objects.size).toBe(0);
  });

  it('does not retry other errors', async () => {
    const admin = new LaggingApisix(5, 'invalid configuration');
    await expect(reconciler(admin).reconcileVersion(VERSION)).rejects.toThrow(/invalid/);
    expect(admin.attempts).toBe(1);
  });
});

describe("APISIX reconciler: the assertion's signing key (M6-10)", () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';
  let kid = 'den-gw-1';
  const keys = {
    current: () => Promise.resolve({ kid, privateKeyPem: PEM }),
  } as unknown as GatewaySigningKeysService;
  const withAssertion = (admin: ApisixAdmin, on: boolean) =>
    new ApisixReconciler(
      prisma,
      {} as QueueService,
      admin,
      { ...settings, ...(on ? { assertion: { issuer: 'https://gw.example' } } : {}) },
      {} as GatewayCertificates,
      keys,
    );

  it('puts the current key in the metadata, then leaves it while the kid is the same', async () => {
    const admin = new LaggingApisix(0);
    const reconciler = withAssertion(admin, true);
    expect(await reconciler.reconcileAssertionKey()).toBe('created');
    expect(admin.objects.get('plugin_metadata/den-assertion')).toEqual({
      issuer: 'https://gw.example',
      kid: 'den-gw-1',
      private_key: PEM,
    });
    // APISIX returns the key encrypted: only issuer and kid are compared.
    const encrypted = { issuer: 'https://gw.example', kid: 'den-gw-1', private_key: 'encrypted' };
    admin.objects.set('plugin_metadata/den-assertion', encrypted);
    expect(await reconciler.reconcileAssertionKey()).toBe('unchanged');
    kid = 'den-gw-2';
    expect(await reconciler.reconcileAssertionKey()).toBe('updated');
    expect(admin.objects.get('plugin_metadata/den-assertion')).toMatchObject({ kid: 'den-gw-2' });
  });

  it('writes the key once after a restart, so APISIX encrypts it with its current key (B-31)', async () => {
    const admin = new LaggingApisix(0);
    kid = 'den-gw-1';
    admin.objects.set('plugin_metadata/den-assertion', {
      issuer: 'https://gw.example',
      kid: 'den-gw-1',
      private_key: 'encrypted with a key that left the keyring',
    });
    const restarted = withAssertion(admin, true);
    expect(await restarted.reconcileAssertionKey()).toBe('updated');
    expect(admin.objects.get('plugin_metadata/den-assertion')).toMatchObject({ private_key: PEM });
    expect(await restarted.reconcileAssertionKey()).toBe('unchanged');
  });

  it('removes the key from APISIX when the country turns the assertion off', async () => {
    const admin = new LaggingApisix(0);
    await withAssertion(admin, true).reconcileAssertionKey();
    expect(await withAssertion(admin, false).reconcileAssertionKey()).toBe('deleted');
    expect(admin.objects.has('plugin_metadata/den-assertion')).toBe(false);
    expect(await withAssertion(admin, false).reconcileAssertionKey()).toBe('absent');
  });
});
