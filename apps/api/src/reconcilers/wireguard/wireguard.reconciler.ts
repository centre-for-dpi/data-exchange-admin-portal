import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { nodeDnsName } from '@den/contracts';
import { ENROLLED_NODE_STATUSES } from '../../domain/node/state-machine.js';
import { PrismaService, type Tx } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { HUB_AGENT, type HubAgent, type HubDesiredState, HUB_TIMEOUT_MS } from './hub-agent.js';

/** Outbox topic for changes to the tunnel peers (aggregate node:<id>). */
export const WIREGUARD_SYNC_TOPIC = 'wireguard.sync';
export const WIREGUARD_SYNC_TARGET = 'wg-hub:state';
const FULL_RECONCILE_MS = 60 * 1000;
/** Serializes passes across API replicas ("den_wgsy"): see reconcile(). */
const RECONCILE_LOCK = 0x7269645f77677379n;
/** Lifetime of a pass's transaction, which holds the lock. */
const PASS_TIMEOUT_MS = 60_000;
/** Kept between the last hub call and the end of the transaction. */
const PASS_MARGIN_MS = 5_000;
/** Port of the nodes' TLS listener when a node has not declared one. */
const DEFAULT_SERVICE_PORT = 8443;

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const byKey =
  <T>(key: keyof T) =>
  (a: T, b: T) =>
    String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0;

/**
 * Makes the WireGuard hub hold exactly the enrolled nodes (M4-03, ADR-0023): one peer per node
 * that is enrolled, online or offline (its key and its /32), and one SNI route per node to its
 * tunnel address and service port. A decommissioned node, or one of an offboarded entity, is
 * neither. The desired state comes from PostgreSQL only; the agent receives it whole (idempotent)
 * when it differs from what the hub reports. Runs from the outbox and every minute.
 */
@Injectable()
export class WireguardReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WireguardReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(HUB_AGENT) private readonly hub: HubAgent | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    if (!this.hub) {
      this.logger.warn('DEN_WG_HUB_AGENT_URL / DEN_WG_HUB_AGENT_TOKEN not set: no tunnel peers');
      return;
    }
    await this.queue.work(WIREGUARD_SYNC_TOPIC, () => this.reconcile());
    const pass = () =>
      this.reconcile().catch((error: unknown) =>
        this.logger.warn(`WireGuard hub reconcile failed: ${String(error)}`),
      );
    void pass();
    this.timer = setInterval(() => void pass(), FULL_RECONCILE_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async desired(db: Pick<Tx, 'node'> = this.prisma): Promise<HubDesiredState> {
    const nodes = await db.node.findMany({
      where: {
        status: { in: [...ENROLLED_NODE_STATUSES] },
        wireguardPublicKey: { not: null },
        tunnelAddress: { not: null },
        entity: { status: { in: ['active', 'suspended'] } },
      },
      select: { id: true, wireguardPublicKey: true, tunnelAddress: true, servicePort: true },
    });
    return {
      peers: nodes
        .map((n) => ({ publicKey: n.wireguardPublicKey ?? '', address: n.tunnelAddress ?? '' }))
        .sort(byKey('publicKey')),
      routes: nodes
        .map((n) => ({
          name: nodeDnsName(n.id),
          address: n.tunnelAddress ?? '',
          port: n.servicePort ?? DEFAULT_SERVICE_PORT,
        }))
        .sort(byKey('name')),
    };
  }

  /**
   * One pass at a time across replicas: the lock covers reading the desired state and writing
   * the hub. Otherwise a pass that read the state before a decommission could write it after a
   * later pass, and bring the node's peer back until the next one. A change that commits during a
   * pass queues its own pass (outbox), which waits for the lock and reads the change.
   */
  async reconcile(): Promise<'updated' | 'unchanged'> {
    const hub = this.hub;
    if (!hub) throw new Error('The WireGuard hub agent is not configured');
    let desiredHash = hash(null);
    // The lock lives as long as the transaction: no hub call may outlast it. Each call is cut
    // before the transaction's end, and the write only starts with a full hub timeout left and the
    // transaction (so the lock) still alive.
    const deadline = Date.now() + PASS_TIMEOUT_MS - PASS_MARGIN_MS;
    const left = () => deadline - Date.now();
    const signal = () => AbortSignal.timeout(Math.max(1, Math.min(HUB_TIMEOUT_MS, left())));
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECONCILE_LOCK})`;
          const desired = await this.desired(tx);
          desiredHash = hash(desired);
          const actual = await hub.state(signal());
          const current: HubDesiredState = {
            peers: actual.peers
              .map((p) => ({ publicKey: p.publicKey, address: p.address }))
              .sort(byKey('publicKey')),
            routes: [...actual.routes].sort(byKey('name')),
          };
          let result: 'updated' | 'unchanged' = 'unchanged';
          if (hash(current) !== desiredHash) {
            if (left() < HUB_TIMEOUT_MS) {
              throw new Error('The pass ran out of time before writing the hub; the next one will');
            }
            await tx.$queryRaw`SELECT 1`;
            await hub.apply(desired, signal());
            result = 'updated';
            this.logger.log(
              `WireGuard hub: ${desired.peers.length} peers, ${desired.routes.length} routes`,
            );
          }
          await this.record(desiredHash, null, tx);
          return result;
        },
        // The lock wait and two hub calls (HUB_TIMEOUT_MS each) fit inside, with the margin.
        { timeout: PASS_TIMEOUT_MS, maxWait: 10_000 },
      );
    } catch (error) {
      await this.record(desiredHash, error);
      throw error;
    }
  }

  private async record(
    desiredHash: string,
    error: unknown,
    db: Pick<Tx, 'syncState'> = this.prisma,
  ): Promise<void> {
    const now = new Date();
    const failed = error !== null;
    const message = failed
      ? (error instanceof Error ? error.message : JSON.stringify(error)).slice(0, 1000)
      : null;
    await db.syncState.upsert({
      where: { target: WIREGUARD_SYNC_TARGET },
      create: {
        target: WIREGUARD_SYNC_TARGET,
        system: 'wireguard',
        desiredHash,
        appliedHash: failed ? null : desiredHash,
        status: failed ? 'error' : 'in_sync',
        lastError: message,
        attempts: failed ? 1 : 0,
        appliedAt: failed ? null : now,
      },
      update: failed
        ? { desiredHash, status: 'error', lastError: message, attempts: { increment: 1 } }
        : {
            desiredHash,
            appliedHash: desiredHash,
            status: 'in_sync',
            appliedAt: now,
            lastError: null,
            attempts: 0,
          },
    });
  }
}
