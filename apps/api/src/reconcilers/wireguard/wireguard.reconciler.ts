import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { nodeDnsName } from '@rid/contracts';
import { ENROLLED_NODE_STATUSES } from '../../domain/node/state-machine.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { HUB_AGENT, type HubAgent, type HubDesiredState } from './hub-agent.js';

/** Outbox topic for changes to the tunnel peers (aggregate node:<id>). */
export const WIREGUARD_SYNC_TOPIC = 'wireguard.sync';
export const WIREGUARD_SYNC_TARGET = 'wg-hub:state';
const FULL_RECONCILE_MS = 60 * 1000;
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
      this.logger.warn('RID_WG_HUB_AGENT_URL / RID_WG_HUB_AGENT_TOKEN not set: no tunnel peers');
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

  async desired(): Promise<HubDesiredState> {
    const nodes = await this.prisma.node.findMany({
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

  async reconcile(): Promise<'updated' | 'unchanged'> {
    if (!this.hub) throw new Error('The WireGuard hub agent is not configured');
    const desired = await this.desired();
    const desiredHash = hash(desired);
    try {
      const actual = await this.hub.state();
      const current: HubDesiredState = {
        peers: actual.peers
          .map((p) => ({ publicKey: p.publicKey, address: p.address }))
          .sort(byKey('publicKey')),
        routes: [...actual.routes].sort(byKey('name')),
      };
      let result: 'updated' | 'unchanged' = 'unchanged';
      if (hash(current) !== desiredHash) {
        await this.hub.apply(desired);
        result = 'updated';
        this.logger.log(
          `WireGuard hub: ${desired.peers.length} peers, ${desired.routes.length} routes`,
        );
      }
      await this.record(desiredHash, null);
      return result;
    } catch (error) {
      await this.record(desiredHash, error);
      throw error;
    }
  }

  private async record(desiredHash: string, error: unknown): Promise<void> {
    const now = new Date();
    const failed = error !== null;
    const message = failed
      ? (error instanceof Error ? error.message : JSON.stringify(error)).slice(0, 1000)
      : null;
    await this.prisma.syncState.upsert({
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
