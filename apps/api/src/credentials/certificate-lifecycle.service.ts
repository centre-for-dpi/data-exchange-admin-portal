import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import { AuditService } from '../audit/audit.service.js';
import { canTransition, type CredentialStatus } from '../domain/credential/state-machine.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';
import { QueueService } from '../queue/queue.service.js';

const SYSTEM = { type: 'system' as const, id: 'system:certificate-lifecycle' };
const EXPIRABLE: CredentialStatus[] = ['active', 'rotating'];
const DAY = 24 * 60 * 60 * 1000;
const BATCH = 500;

/**
 * Time-driven steps of a client certificate (SPEC.md §4.3, M3-01), every
 * RID_LIFECYCLE_INTERVAL_SECONDS (default 300):
 * - expiry notice: lifecycle.certificateExpiryWarningDays before notAfter, once per certificate.
 *   The audited `credential.expiry_notice_queued` reaches the entity's app developers as a
 *   notification (in the portal and by e-mail, M2-08);
 * - expiry: certificates past notAfter become `expired`, so the state and the trail say so
 *   (TLS already refuses them by date).
 */
@Injectable()
export class CertificateLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CertificateLifecycleService.name);
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
    return { expired: await this.expireDue(now), noticed: await this.queueExpiryNotices(now) };
  }

  /** Expires certificates past their validity; idempotent. */
  async expireDue(now = new Date()): Promise<string[]> {
    const due = await this.prisma.credential.findMany({
      where: { kind: 'mtls_certificate', status: { in: EXPIRABLE }, notAfter: { lte: now } },
      select: { id: true, status: true, notAfter: true },
      orderBy: { notAfter: 'asc' },
      take: BATCH,
    });
    const expired: string[] = [];
    for (const c of due) {
      if (!canTransition(c.status, 'expired')) continue;
      const done = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.credential.updateMany({
          where: { id: c.id, status: c.status, notAfter: { lte: now } },
          data: { status: 'expired' },
        });
        if (changed.count === 0) return false;
        await this.audit.record(tx, {
          actor: SYSTEM,
          action: 'credential.expired',
          target: { type: 'credential', id: c.id },
          before: { status: c.status },
          after: { status: 'expired', notAfter: c.notAfter?.toISOString() },
        });
        await this.outbox.enqueue(tx, {
          topic: POLICY_SYNC_TOPIC,
          aggregate: `credential:${c.id}`,
          payload: { reason: 'certificate_expired' },
        });
        return true;
      });
      if (done) expired.push(c.id);
    }
    return expired;
  }

  /** Marks and queues the notice of active certificates entering the warning period. */
  async queueExpiryNotices(now = new Date()): Promise<string[]> {
    const days = getCountryConfig().lifecycle.certificateExpiryWarningDays;
    const due = await this.prisma.credential.findMany({
      where: {
        kind: 'mtls_certificate',
        status: 'active',
        expiryNoticeSentAt: null,
        notAfter: { gt: now, lte: new Date(now.getTime() + days * DAY) },
        application: { status: 'active' },
      },
      select: { id: true, notAfter: true },
      orderBy: { notAfter: 'asc' },
      take: BATCH,
    });
    const noticed: string[] = [];
    for (const { id, notAfter } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.credential.updateMany({
          where: { id, status: 'active', expiryNoticeSentAt: null },
          data: { expiryNoticeSentAt: now },
        });
        if (changed.count === 0) return false;
        await this.audit.record(tx, {
          actor: SYSTEM,
          action: 'credential.expiry_notice_queued',
          target: { type: 'credential', id },
          after: { expiryNoticeSentAt: now.toISOString(), notAfter: notAfter?.toISOString() },
        });
        return true;
      });
      if (done) noticed.push(id);
    }
    return noticed;
  }
}
