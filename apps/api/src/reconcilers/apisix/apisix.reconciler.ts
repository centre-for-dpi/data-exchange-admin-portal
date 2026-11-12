import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { upstreamSchema } from '@rid/contracts';
import { listOperations } from '../../apis/lint/openapi-lint.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { APISIX_ADMIN, type ApisixAdmin } from './apisix-admin.js';
import {
  desiredGateway,
  type GatewaySettings,
  MANAGED_PREFIX,
  matches,
  routeId,
  upstreamId,
} from './desired-state.js';

/** Outbox topic for changes that affect an API version's route (aggregate apiVersion:<id>). */
export const GATEWAY_SYNC_TOPIC = 'gateway.sync';
export const APISIX_SETTINGS = Symbol('APISIX_SETTINGS');
const FULL_RECONCILE_MS = 5 * 60 * 1000;

/** Versions the gateway serves: deprecated ones keep working until they are retired. */
const SERVED = ['published', 'deprecated'] as const;

export type GatewayResult = 'created' | 'updated' | 'unchanged' | 'deleted' | 'absent';

export const gatewaySyncTarget = (apiVersionId: string): string =>
  `apisix:route:${routeId(apiVersionId)}`;

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Makes APISIX hold exactly one upstream and one route per served API version
 * (ARCHITECTURE.md §4, §4.1). Desired state comes from PostgreSQL only; the reconciler reads
 * APISIX, writes the difference with idempotent PUTs on deterministic ids and records the outcome
 * in sync_state. Runs from the outbox (gateway.sync) and as a full pass every 5 minutes, which
 * also removes `rid-` objects nothing in the database asks for. Objects without the prefix are
 * never touched.
 */
@Injectable()
export class ApisixReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ApisixReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(APISIX_ADMIN) private readonly admin: ApisixAdmin,
    @Inject(APISIX_SETTINGS) private readonly settings: GatewaySettings,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(GATEWAY_SYNC_TOPIC, (data) => this.handle(data));
    // Converge right after a restart instead of waiting for the first periodic pass.
    void this.reconcileAll();
    this.timer = setInterval(() => void this.reconcileAll(), FULL_RECONCILE_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async handle(data: Record<string, unknown>): Promise<void> {
    const [kind, id] = (typeof data.aggregate === 'string' ? data.aggregate : '').split(':');
    if (kind === 'apiVersion' && id) await this.reconcileVersion(id);
  }

  /** Full pass: every served version, then orphans. Errors are recorded per version. */
  async reconcileAll(): Promise<void> {
    const versions = await this.prisma.apiVersion.findMany({
      where: { status: { in: [...SERVED] } },
      select: { id: true },
    });
    for (const v of versions) {
      try {
        await this.reconcileVersion(v.id);
      } catch (error) {
        this.logger.warn(`APISIX reconcile of version ${v.id} failed: ${String(error)}`);
      }
    }
    try {
      await this.removeOrphans(new Set(versions.map((v) => v.id)));
    } catch (error) {
      this.logger.warn(`APISIX orphan cleanup failed: ${String(error)}`);
    }
  }

  /** Deletes managed routes and upstreams whose version is not served (route first). */
  private async removeOrphans(served: ReadonlySet<string>): Promise<void> {
    const managed = (ids: string[], prefix: string) =>
      ids
        .filter((id) => id.startsWith(`${MANAGED_PREFIX}${prefix}-`))
        .filter((id) => !served.has(id.slice(`${MANAGED_PREFIX}${prefix}-`.length)));
    for (const id of managed(await this.admin.list('routes'), 'route')) {
      await this.admin.delete('routes', id);
      this.logger.log(`Removed orphan APISIX route ${id}`);
    }
    for (const id of managed(await this.admin.list('upstreams'), 'upstream')) {
      await this.admin.delete('upstreams', id);
      this.logger.log(`Removed orphan APISIX upstream ${id}`);
    }
  }

  async reconcileVersion(apiVersionId: string): Promise<GatewayResult> {
    const version = await this.prisma.apiVersion.findUnique({
      where: { id: apiVersionId },
      include: { api: { include: { entity: true } } },
    });
    const target = gatewaySyncTarget(apiVersionId);
    const served = version && (SERVED as readonly string[]).includes(version.status);
    let desiredHash = hash(null);

    try {
      if (!served) {
        const existed = await this.removeVersion(apiVersionId);
        if (version) await this.recordSuccess(target, desiredHash);
        return existed ? 'deleted' : 'absent';
      }

      const desired = desiredGateway(
        {
          id: version.id,
          basePath: version.basePath,
          upstream: upstreamSchema.parse(version.upstream),
          methods: listOperations(version.openapiSpec as Record<string, unknown>).map(
            (o) => o.method,
          ),
          entitySlug: version.api.entity.slug,
          apiName: version.api.name,
          version: version.version,
        },
        this.settings,
      );
      desiredHash = hash(desired);

      // Upstream before route: the route references it.
      const upstream = await this.apply('upstreams', upstreamId(apiVersionId), desired.upstream);
      const route = await this.apply('routes', routeId(apiVersionId), desired.route);
      await this.recordSuccess(target, desiredHash);
      if (upstream === 'created' || route === 'created') return 'created';
      if (upstream === 'updated' || route === 'updated') return 'updated';
      return 'unchanged';
    } catch (error) {
      await this.recordError(target, desiredHash, error);
      throw error;
    }
  }

  private async apply(
    kind: 'routes' | 'upstreams',
    id: string,
    desired: Record<string, unknown>,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const actual = await this.admin.get(kind, id);
    if (actual && matches(desired, actual)) return 'unchanged';
    await this.admin.put(kind, id, desired);
    return actual ? 'updated' : 'created';
  }

  /** Route first, then upstream (APISIX refuses to delete an upstream still in use). */
  private async removeVersion(apiVersionId: string): Promise<boolean> {
    const route = await this.admin.get('routes', routeId(apiVersionId));
    const upstream = await this.admin.get('upstreams', upstreamId(apiVersionId));
    if (route) await this.admin.delete('routes', routeId(apiVersionId));
    if (upstream) await this.admin.delete('upstreams', upstreamId(apiVersionId));
    return Boolean(route || upstream);
  }

  private async recordSuccess(target: string, desiredHash: string): Promise<void> {
    const now = new Date();
    await this.prisma.syncState.upsert({
      where: { target },
      create: {
        target,
        system: 'apisix',
        desiredHash,
        appliedHash: desiredHash,
        status: 'in_sync',
        appliedAt: now,
      },
      update: {
        desiredHash,
        appliedHash: desiredHash,
        status: 'in_sync',
        appliedAt: now,
        lastError: null,
        attempts: 0,
      },
    });
  }

  private async recordError(target: string, desiredHash: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await this.prisma.syncState.upsert({
      where: { target },
      create: {
        target,
        system: 'apisix',
        desiredHash,
        status: 'error',
        lastError: message,
        attempts: 1,
      },
      update: { desiredHash, status: 'error', lastError: message, attempts: { increment: 1 } },
    });
  }
}
