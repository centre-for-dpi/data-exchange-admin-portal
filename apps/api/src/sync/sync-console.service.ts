import { Injectable } from '@nestjs/common';
import type { SyncPage, SyncQuery } from '@rid/contracts';
import { OPENSEARCH_SYNC_TOPIC } from '../analytics/access-log-index.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { NotFoundError } from '../common/errors.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import { KEYCLOAK_SYNC_TOPIC } from '../reconcilers/keycloak/keycloak.reconciler.js';
import { WIREGUARD_SYNC_TOPIC } from '../reconcilers/wireguard/wireguard.reconciler.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_ROUTE = /^apisix:route:rid-route-([0-9a-f-]{36})$/;
const KEYCLOAK_CLIENT = /^keycloak:client:(.+)$/;

/**
 * The operator's sync console (M5-07): what the reconcilers keep (sync_state), the drift they
 * found, and a manual retry. A retry never calls APISIX, Keycloak or the others from here: it
 * queues the reconciler's own job for that object (CLAUDE.md), and is audited.
 */
@Injectable()
export class SyncConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(query: SyncQuery): Promise<SyncPage> {
    const dayAgo = new Date(Date.now() - DAY_MS);
    const where: Prisma.SyncStateWhereInput = {
      ...(query.system ? { system: query.system } : {}),
      ...(query.q ? { target: { contains: query.q } } : {}),
      ...(query.status === 'problems'
        ? {
            OR: [
              { status: { in: ['pending', 'error', 'drift'] } },
              { driftDetectedAt: { gte: dayAgo } },
            ],
          }
        : query.status
          ? { status: query.status }
          : {}),
    };
    const [summary, recentDrift, rows] = await Promise.all([
      this.prisma.syncState.groupBy({ by: ['system', 'status'], _count: { _all: true } }),
      this.prisma.syncState.count({ where: { driftDetectedAt: { gte: dayAgo } } }),
      this.prisma.syncState.findMany({
        where,
        orderBy: { target: 'asc' },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { target: query.cursor }, skip: 1 } : {}),
      }),
    ]);
    const items = rows.slice(0, query.limit);
    return {
      summary: summary
        .map((s) => ({ system: s.system, status: s.status, count: s._count._all }))
        .sort((a, b) => a.system.localeCompare(b.system) || a.status.localeCompare(b.status)),
      recentDrift,
      items: items.map((r) => ({
        target: r.target,
        system: r.system,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
        appliedAt: r.appliedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
        applied: r.appliedHash === r.desiredHash,
        driftDetectedAt: r.driftDetectedAt?.toISOString() ?? null,
        driftCount: r.driftCount,
      })),
      nextCursor: rows.length > query.limit ? (items.at(-1)?.target ?? null) : null,
    };
  }

  /** Queues the reconcile of one object now, instead of waiting for the next periodic pass. */
  async retry(target: string, principal: Principal, requestId?: string) {
    const row = await this.prisma.syncState.findUnique({ where: { target } });
    if (!row) throw new NotFoundError('Sync target');
    const job = await this.jobFor(row.target);
    await this.prisma.$transaction(async (tx) => {
      await this.outbox.enqueue(tx, job);
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub },
        action: 'sync.retry_requested',
        target: { type: 'sync_target', id: row.target },
        before: { status: row.status, attempts: row.attempts },
        after: { topic: job.topic, aggregate: job.aggregate },
        requestId,
      });
    });
    return { queued: true as const, target: row.target };
  }

  /** The job of the reconciler that owns a target. */
  private async jobFor(target: string): Promise<{ topic: string; aggregate: string }> {
    const version = VERSION_ROUTE.exec(target)?.[1];
    if (version) return { topic: GATEWAY_SYNC_TOPIC, aggregate: `apiVersion:${version}` };
    // The gateway's own objects (TLS, token and control routes): a full gateway pass.
    if (target.startsWith('apisix:'))
      return { topic: GATEWAY_SYNC_TOPIC, aggregate: 'gateway:all' };
    const clientId = KEYCLOAK_CLIENT.exec(target)?.[1];
    if (clientId) {
      const app = await this.prisma.application.findUnique({
        where: { keycloakClientId: clientId },
        select: { id: true },
      });
      if (!app) throw new NotFoundError('Application of the sync target');
      return { topic: KEYCLOAK_SYNC_TOPIC, aggregate: `application:${app.id}` };
    }
    if (target.startsWith('opa:')) return { topic: POLICY_SYNC_TOPIC, aggregate: 'console:retry' };
    if (target.startsWith('wg-hub:')) return { topic: WIREGUARD_SYNC_TOPIC, aggregate: 'hub:all' };
    if (target.startsWith('opensearch:')) {
      return { topic: OPENSEARCH_SYNC_TOPIC, aggregate: 'opensearch:all' };
    }
    throw new NotFoundError('Reconciler of the sync target');
  }
}
