import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { QueueService } from '../../queue/queue.service.js';
import { type ApisixAdmin, ApisixAdminError, type ApisixKind } from './apisix-admin.js';
import { ApisixReconciler } from './apisix.reconciler.js';
import { type GatewaySettings, parseDevNodes, routeId, upstreamId } from './desired-state.js';
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
  keycloakDiscoveryUrl: 'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
  audience: 'rid-gateway',
  opaUrl: 'http://opa:8181',
  accessLogUrl: 'http://fluent-bit:9880/',
  transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
  devNodes: parseDevNodes(''),
  resolveHost: () => Promise.resolve([]),
  tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'rid-gateway' },
};

/** Only what reconcileVersion touches for a retired version. */
const prisma = {
  apiVersion: { findUnique: () => Promise.resolve({ id: VERSION, status: 'retired' }) },
  syncState: { upsert: () => Promise.resolve({}) },
} as unknown as PrismaService;

const reconciler = (admin: ApisixAdmin) =>
  new ApisixReconciler(prisma, {} as QueueService, admin, settings, {} as GatewayCertificates);

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
