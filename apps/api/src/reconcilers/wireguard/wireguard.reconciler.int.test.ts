import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { nodeDnsName } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import type { HubActualState, HubAgent, HubDesiredState } from './hub-agent.js';
import { WIREGUARD_SYNC_TARGET, WireguardReconciler } from './wireguard.reconciler.js';

const wireguardKey = (): string => {
  const { x } = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
  return Buffer.from(x ?? '', 'base64url').toString('base64');
};

/** An in-memory hub: what it was told, as the real agent reports it back. */
class FakeHub implements HubAgent {
  applied: HubDesiredState[] = [];
  current: HubDesiredState = { peers: [], routes: [] };
  failing = false;

  state(_signal?: AbortSignal): Promise<HubActualState> {
    if (this.failing) return Promise.reject(new Error('hub unreachable'));
    return Promise.resolve({
      publicKey: wireguardKey(),
      address: '10.77.0.1',
      listenPort: 51820,
      peers: this.current.peers.map((p) => ({ ...p, endpoint: null, latestHandshake: null })),
      routes: this.current.routes,
    });
  }

  apply(desired: HubDesiredState, _signal?: AbortSignal): Promise<HubActualState> {
    this.applied.push(desired);
    this.current = desired;
    return this.state();
  }
}

/**
 * Desired state of the WireGuard hub from PostgreSQL (M4-03). The test database is shared by the
 * whole suite, so the checks look at this test's nodes only.
 */
describe('WireGuard hub reconciler (M4-03)', () => {
  const prisma = new PrismaService();
  const hub = new FakeHub();
  const reconciler = new WireguardReconciler(prisma, new QueueService(prisma), hub);
  let entityId = '';

  async function entity(status: 'active' | 'offboarded' = 'active') {
    const id = randomUUID().slice(0, 8);
    const row = await prisma.entity.create({
      data: {
        legalName: `Entidad hub ${id}`,
        shortName: `H ${id}`,
        slug: `hub-${id}`,
        taxIdType: 'NIT',
        taxId: `3${id}`,
        kind: 'national',
        sector: 'salud',
        status,
        contactEmail: `c.${id}@example.org`,
        dpoName: 'Dora',
        dpoEmail: `d.${id}@example.org`,
        createdBy: 'test',
      },
    });
    return row.id;
  }

  const octet = () => Math.floor(Math.random() * 250) + 2;
  async function node(
    status: 'enrollment_issued' | 'enrolled' | 'online' | 'offline' | 'decommissioned',
    owner = entityId,
    servicePort: number | null = 8443,
  ) {
    const enrolled = status !== 'enrollment_issued';
    return prisma.node.create({
      data: {
        entityId: owner,
        name: `nodo-${randomUUID().slice(0, 8)}`,
        status,
        ...(enrolled
          ? {
              wireguardPublicKey: wireguardKey(),
              tunnelAddress: `10.${octet()}.${octet()}.${octet()}`,
              servicePort,
            }
          : {}),
        createdBy: 'test',
      },
    });
  }

  beforeAll(async () => {
    entityId = await entity();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const has = (state: HubDesiredState, n: { id: string; wireguardPublicKey: string | null }) => ({
    peer: state.peers.some((p) => p.publicKey === n.wireguardPublicKey),
    route: state.routes.some((r) => r.name === nodeDnsName(n.id)),
  });

  it('holds a peer and an SNI route for every enrolled node, and nothing else', async () => {
    const online = await node('online');
    const offline = await node('offline');
    const enrolled = await node('enrolled', entityId, null);
    const pending = await node('enrollment_issued');
    const gone = await node('decommissioned');
    const offboarded = await node('online', await entity('offboarded'));

    const desired = await reconciler.desired();
    for (const n of [online, offline, enrolled]) {
      expect(has(desired, n), n.status).toEqual({ peer: true, route: true });
    }
    for (const n of [pending, gone, offboarded]) {
      expect(has(desired, n), n.status).toEqual({ peer: false, route: false });
    }
    // The route goes to the node's tunnel address and port; 8443 when it declared none.
    expect(desired.routes.find((r) => r.name === nodeDnsName(enrolled.id))).toEqual({
      name: nodeDnsName(enrolled.id),
      address: enrolled.tunnelAddress,
      port: 8443,
    });
  });

  it('writes the hub only when it differs, and records the outcome', async () => {
    await node('online');
    expect(await reconciler.reconcile()).toBe('updated');
    expect(await reconciler.reconcile()).toBe('unchanged');
    const sync = await prisma.syncState.findUniqueOrThrow({
      where: { target: WIREGUARD_SYNC_TARGET },
    });
    expect(sync).toMatchObject({ system: 'wireguard', status: 'in_sync' });

    // A decommissioned node leaves the hub on the next pass.
    const n = await node('online');
    await reconciler.reconcile();
    expect(has(hub.current, n)).toEqual({ peer: true, route: true });
    await prisma.node.updateMany({ where: { id: n.id }, data: { status: 'decommissioned' } });
    expect(await reconciler.reconcile()).toBe('updated');
    expect(has(hub.current, n)).toEqual({ peer: false, route: false });
  });

  it('runs one pass at a time: a stale pass never writes after a newer one', async () => {
    const n = await node('online');
    // The first pass is slow to reach the hub; the node is decommissioned meanwhile and a second
    // pass starts. The second waits for the first, then reads the decommission.
    let release = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const original = hub.state.bind(hub);
    let calls = 0;
    hub.state = async () => {
      calls += 1;
      if (calls === 1) await slow;
      return original();
    };
    try {
      const first = reconciler.reconcile();
      await new Promise((r) => setTimeout(r, 200));
      await prisma.node.updateMany({ where: { id: n.id }, data: { status: 'decommissioned' } });
      const second = reconciler.reconcile();
      await new Promise((r) => setTimeout(r, 200));
      release();
      await Promise.all([first, second]);
    } finally {
      hub.state = original;
    }
    expect(has(hub.current, n)).toEqual({ peer: false, route: false });
  });

  it('records an unreachable hub as a sync error', async () => {
    hub.failing = true;
    try {
      await expect(reconciler.reconcile()).rejects.toThrow('hub unreachable');
      const sync = await prisma.syncState.findUniqueOrThrow({
        where: { target: WIREGUARD_SYNC_TARGET },
      });
      expect(sync.status).toBe('error');
      expect(sync.lastError).toBe('hub unreachable');
    } finally {
      hub.failing = false;
    }
    await reconciler.reconcile();
  });
});
