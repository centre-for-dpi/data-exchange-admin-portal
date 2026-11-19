import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { PrismaService } from '../prisma/prisma.service.js';

export const PGBOSS_SCHEMA = 'pgboss';
const RELAY_INTERVAL_MS = 1_000;
const RELAY_BATCH = 100;
/** Time a relay batch may take (Prisma's interactive transactions default to 5 s). */
const RELAY_TX_TIMEOUT_MS = 60_000;
/** How often relayed outbox rows past their retention are purged, and how many per statement. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_BATCH = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days a relayed outbox row is kept (DEN_OUTBOX_RETENTION_DAYS, default 7): long enough to look
 * into a recent sync, never forever (B-14). Rows not yet relayed are never purged. A malformed
 * value is a startup error.
 */
export function outboxRetentionDays(value = process.env.DEN_OUTBOX_RETENTION_DAYS): number {
  if (value === undefined || value.trim() === '') return 7;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      `DEN_OUTBOX_RETENTION_DAYS must be a whole number of days (>= 1), got "${value}"`,
    );
  }
  return days;
}

/**
 * Queues that are not reconcilers. Reconciliation queues coalesce by aggregate (`stately`);
 * notification queues deliver every message and retry longer, with backoff.
 */
const QUEUE_OPTIONS: Record<string, Parameters<PgBoss['createQueue']>[1]> = {
  // Citizen notices (MT-06): up to ~17 hours of retries (30 s doubling, capped at 1 h).
  'citizen.alert': {
    policy: 'standard',
    retryLimit: 20,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
  },
  // Notifications (M2-08): one job per audit event; in-portal rows are idempotent.
  'notification.dispatch': {
    policy: 'standard',
    retryLimit: 20,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
  },
  // Daily anchor e-mails to the regulators (M2-09).
  'audit.anchor_email': {
    policy: 'standard',
    retryLimit: 20,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
  },
  // Invitation e-mails (M2-01): every message is delivered; SMTP outages are retried for hours.
  'invitation.email': {
    policy: 'standard',
    retryLimit: 20,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
  },
};

interface PendingMessage {
  id: string;
  topic: string;
  aggregate: string;
  payload: Record<string, unknown>;
}

/**
 * Background work on pg-boss (no Redis, ADR-0002/0007).
 * - Relays outbox rows to queues (one queue per topic). Delivery is at-least-once; reconcilers
 *   are idempotent, and the `stately` policy keyed by aggregate coalesces repeated changes.
 * - Queue handlers (reconcilers) are registered from M1-08; until then queues have no workers.
 * The pg-boss schema is created by a Prisma migration, so pg-boss never runs DDL here.
 * Set DEN_WORKER=off to run the API without background work (tests, read-only replicas).
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private boss?: PgBoss;
  private timer?: NodeJS.Timeout;
  private purgeTimer?: NodeJS.Timeout;
  private relaying = false;
  private readonly knownQueues = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  static enabled(): boolean {
    return process.env.DEN_WORKER !== 'off';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    const retentionDays = outboxRetentionDays();
    await this.start();
    this.timer = setInterval(() => void this.relayOnce(), RELAY_INTERVAL_MS);
    const purge = () =>
      this.purgeOutbox(retentionDays).catch((error: unknown) =>
        this.logger.warn(`Outbox purge failed: ${String(error)}`),
      );
    void purge();
    this.purgeTimer = setInterval(() => void purge(), PURGE_INTERVAL_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = undefined;
  }

  /** Starts pg-boss without letting it create or migrate its schema. */
  async start(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: PGBOSS_SCHEMA,
      migrate: false,
      createSchema: false,
      schedule: false,
    });
    boss.on('error', (error) => this.logger.error(error));
    await boss.start();
    this.boss = boss;
    return boss;
  }

  get instance(): PgBoss {
    if (!this.boss) throw new Error('pg-boss is not started');
    return this.boss;
  }

  private async ensureQueue(name: string): Promise<void> {
    if (this.knownQueues.has(name)) return;
    if (!(await this.instance.getQueue(name))) {
      await this.instance.createQueue(name, QUEUE_OPTIONS[name] ?? { policy: 'stately' });
    }
    this.knownQueues.add(name);
  }

  /**
   * Registers a handler (a reconciler) for a queue. A failing job is retried by pg-boss; the
   * handler must be idempotent (ADR-0007).
   */
  async work(
    topic: string,
    handler: (data: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    await this.start();
    await this.ensureQueue(topic);
    // Batches drain a backlog (e.g. after downtime) without waiting a polling interval per job;
    // a one-second poll keeps a single change well inside the 60 s target (SPEC.md §4.4).
    await this.instance.work<Record<string, unknown>>(
      topic,
      { batchSize: 10, pollingIntervalSeconds: 1, burstWhenBatchFull: true },
      async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(job.data);
          } catch (error) {
            // Fail only this job (pg-boss retries it); the rest of the batch completes normally.
            await this.instance.fail(topic, job.id, {
              message: error instanceof Error ? error.message.slice(0, 1000) : String(error),
            });
          }
        }
      },
    );
  }

  /**
   * Deletes the outbox rows relayed more than `retentionDays` ago (B-14), in batches so no
   * statement holds many rows. Returns how many were deleted. Idempotent: every replica may run it.
   */
  async purgeOutbox(retentionDays = outboxRetentionDays(), now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM outbox WHERE id IN (
          SELECT id FROM outbox
          WHERE published_at IS NOT NULL AND published_at < ${cutoff}
          ORDER BY created_at
          LIMIT ${PURGE_BATCH})`;
      total += deleted;
      if (deleted < PURGE_BATCH) return total;
    }
  }

  /** Moves pending outbox rows to their queues. Returns how many rows were processed. */
  async relayOnce(limit = RELAY_BATCH): Promise<number> {
    if (this.relaying || !this.boss) return 0;
    this.relaying = true;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const pending = await tx.$queryRaw<PendingMessage[]>`
          SELECT id, topic, aggregate, payload
          FROM outbox
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`;
          for (const message of pending) {
            try {
              await this.ensureQueue(message.topic);
              // null means a job for this aggregate is already queued: it will see the latest state.
              await this.instance.send(
                message.topic,
                { ...message.payload, aggregate: message.aggregate, outboxId: message.id },
                { singletonKey: message.aggregate },
              );
              await tx.outboxMessage.update({
                where: { id: message.id },
                data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null },
              });
            } catch (error) {
              await tx.outboxMessage.update({
                where: { id: message.id },
                data: {
                  attempts: { increment: 1 },
                  lastError: error instanceof Error ? error.message.slice(0, 1000) : String(error),
                },
              });
            }
          }
          return pending.length;
          // Each message is a pg-boss send: a full batch on a loaded database can take more than
          // Prisma's default 5 s, and an expired transaction would relay nothing, ever again.
        },
        { timeout: RELAY_TX_TIMEOUT_MS, maxWait: RELAY_TX_TIMEOUT_MS },
      );
    } catch (error) {
      this.logger.error(error);
      return 0;
    } finally {
      this.relaying = false;
    }
  }
}
