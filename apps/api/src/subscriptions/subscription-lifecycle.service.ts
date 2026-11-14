import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import type { SubscriptionStatus } from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import { LIVE_STATUSES } from '../domain/subscription/state-machine.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { POLICY_SYNC_TOPIC } from './subscriptions.service.js';

const SYSTEM = { type: 'system' as const, id: 'system:subscription-lifecycle' };
const EXPIRABLE: SubscriptionStatus[] = ['approved', 'active', 'suspended'];
const DAY = 24 * 60 * 60 * 1000;

/**
 * Time-driven steps of a subscription (SPEC.md §4.4, M2-06), every
 * RID_LIFECYCLE_INTERVAL_SECONDS (default 300):
 * - expiry: granted subscriptions past validUntil become `expired` (OPA also denies them by
 *   date; this makes the state and the audit trail say so) and the policy is resynced;
 * - renewal notice: lifecycle.subscriptionRenewalNoticeDays before validUntil, once, unless a
 *   renewal is in progress. The audited `subscription.renewal_notice_queued` reaches the
 *   requester as a notification (in the portal and by e-mail, M2-08).
 */
@Injectable()
export class SubscriptionLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  onApplicationBootstrap(): void {
    if (!QueueService.enabled()) return;
    const seconds = Number(process.env.RID_LIFECYCLE_INTERVAL_SECONDS ?? 300);
    this.timer = setInterval(
      () => {
        this.tick().catch((error: unknown) =>
          this.logger.error(error instanceof Error ? error.message : String(error)),
        );
      },
      (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<{ expired: string[]; noticed: string[] }> {
    return { expired: await this.expireDue(now), noticed: await this.queueRenewalNotices(now) };
  }

  /** Expires granted subscriptions past their validity; idempotent. */
  async expireDue(now = new Date()): Promise<string[]> {
    const due = await this.prisma.subscription.findMany({
      where: { status: { in: EXPIRABLE }, validUntil: { lte: now } },
      select: { id: true, status: true, validUntil: true },
      take: 500,
    });
    const expired: string[] = [];
    for (const s of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.subscription.updateMany({
          where: { id: s.id, status: s.status, validUntil: { lte: now } },
          data: { status: 'expired' },
        });
        if (changed.count === 0) return false;
        await this.audit.record(tx, {
          actor: SYSTEM,
          action: 'subscription.expired',
          target: { type: 'subscription', id: s.id },
          before: { status: s.status },
          after: { status: 'expired', validUntil: s.validUntil.toISOString() },
        });
        await this.outbox.enqueue(tx, {
          topic: POLICY_SYNC_TOPIC,
          aggregate: `subscription:${s.id}`,
          payload: { reason: 'expired' },
        });
        return true;
      });
      if (done) expired.push(s.id);
    }
    return expired;
  }

  /** Marks and queues the renewal notice of subscriptions entering the notice period. */
  async queueRenewalNotices(now = new Date()): Promise<string[]> {
    const days = getCountryConfig().lifecycle.subscriptionRenewalNoticeDays;
    const due = await this.prisma.subscription.findMany({
      where: {
        status: 'active',
        renewalNoticeSentAt: null,
        validUntil: { gt: now, lte: new Date(now.getTime() + days * DAY) },
        renewals: { none: { status: { in: [...LIVE_STATUSES] } } },
      },
      select: { id: true },
      take: 500,
    });
    const noticed: string[] = [];
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.subscription.updateMany({
          where: { id, renewalNoticeSentAt: null },
          data: { renewalNoticeSentAt: now },
        });
        if (changed.count === 0) return false;
        await this.audit.record(tx, {
          actor: SYSTEM,
          action: 'subscription.renewal_notice_queued',
          target: { type: 'subscription', id },
          after: { renewalNoticeSentAt: now.toISOString() },
        });
        return true;
      });
      if (done) noticed.push(id);
    }
    return noticed;
  }
}
