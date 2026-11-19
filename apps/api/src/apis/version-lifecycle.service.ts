import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SubscriptionStatus } from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import { assertTransition } from '../domain/api-version/state-machine.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';
import { ApisService } from './apis.service.js';

const SYSTEM = { type: 'system' as const, id: 'system:version-lifecycle' };
/** Subscriptions that still hold or may get access; the rest are already closed. */
const PENDING: SubscriptionStatus[] = ['pending_provider', 'pending_regulator', 'info_requested'];
const GRANTED: SubscriptionStatus[] = ['approved', 'active', 'suspended'];

/**
 * Retirement of deprecated versions on their date (SPEC.md §4.2 step 5, ADR-0019). Every
 * DEN_LIFECYCLE_INTERVAL_SECONDS (default 300) the API retires the deprecated versions whose
 * sunsetAt has passed: the version becomes `retired` (the reconciler removes its route), live
 * subscriptions are revoked and pending requests rejected, all in one audited transaction per
 * version. Idempotent: each version moves only from `deprecated`.
 */
@Injectable()
export class VersionLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(VersionLifecycleService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly apis: ApisService,
  ) {}

  onApplicationBootstrap(): void {
    if (!QueueService.enabled()) return;
    const seconds = Number(process.env.DEN_LIFECYCLE_INTERVAL_SECONDS ?? 300);
    this.timer = setInterval(
      () => {
        this.retireDue().catch((error: unknown) =>
          this.logger.error(error instanceof Error ? error.message : String(error)),
        );
      },
      (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Retires every deprecated version due at `now`; returns their ids. */
  async retireDue(now = new Date()): Promise<string[]> {
    const due = await this.prisma.apiVersion.findMany({
      where: { status: 'deprecated', sunsetAt: { lte: now } },
      select: { id: true },
      take: 100,
    });
    const retired: string[] = [];
    for (const { id } of due) {
      if (await this.retire(id, now)) retired.push(id);
    }
    return retired;
  }

  private async retire(versionId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.apiVersion.findUniqueOrThrow({ where: { id: versionId } });
      assertTransition(version.status, 'retired');
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: 'deprecated', sunsetAt: { lte: now } },
        data: { status: 'retired', retiredAt: now },
      });
      if (changed.count === 0) return false;
      await this.audit.record(tx, {
        actor: SYSTEM,
        action: 'api_version.retired',
        target: { type: 'api_version', id: versionId },
        before: { status: 'deprecated', sunsetAt: version.sunsetAt?.toISOString() ?? null },
        after: { status: 'retired', retiredAt: now.toISOString() },
      });

      // The retirement acts on the provider's decision to deprecate.
      const decidedBy = version.deprecatedBy ?? version.createdBy;
      const subscriptions = await tx.subscription.findMany({
        where: { apiVersionId: versionId, status: { in: [...PENDING, ...GRANTED] } },
        select: { id: true, status: true },
      });
      for (const s of subscriptions) {
        const to: SubscriptionStatus = PENDING.includes(s.status) ? 'rejected' : 'revoked';
        const moved = await tx.subscription.updateMany({
          where: { id: s.id, status: s.status },
          data: { status: to },
        });
        if (moved.count === 0) continue;
        await tx.subscriptionDecision.create({
          data: {
            subscriptionId: s.id,
            decision: to,
            decidedBy,
            decidedByEntityId: null,
            comment: 'The API version was retired',
          },
        });
        await this.audit.record(tx, {
          actor: SYSTEM,
          action: `subscription.${to}`,
          target: { type: 'subscription', id: s.id },
          before: { status: s.status },
          after: { status: to, reason: 'api_version_retired', apiVersionId: versionId },
        });
      }

      await this.apis.refreshApiStatus(tx, version.apiId);
      for (const topic of [GATEWAY_SYNC_TOPIC, POLICY_SYNC_TOPIC]) {
        await this.outbox.enqueue(tx, {
          topic,
          aggregate: `apiVersion:${versionId}`,
          payload: { reason: 'retired' },
        });
      }
      return true;
    });
  }
}
