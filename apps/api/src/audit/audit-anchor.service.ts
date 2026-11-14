import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import { z } from 'zod';
import { localDay, nextDay, startOfLocalDay } from '../common/local-day.js';
import { MAIL_TRANSPORT, type MailTransport } from '../mail/mail.service.js';
import { mailLocale } from '../mail/messages.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { TsaClient } from '../transparency/evidence/tsa.client.js';
import { AuditService } from './audit.service.js';

export const ANCHOR_EMAIL_TOPIC = 'audit.anchor_email';
/** Advisory lock: only one API instance anchors at a time. */
const ANCHOR_LOCK = 4_242_009;
const MAX_DAYS_PER_RUN = 62;
/**
 * Where an anchoring run starts: the day of the next chained event, but never a day already
 * anchored. Jumping to that event (instead of stepping day by day from the last anchor) means a
 * long period without events cannot exhaust a run and stall the anchoring.
 */
export function firstDayToAnchor(
  lastAnchoredDay: string | undefined,
  nextEventDay: string,
): string {
  if (!lastAnchoredDay) return nextEventDay;
  const after = nextDay(lastAnchoredDay);
  return after > nextEventDay ? after : nextEventDay;
}

const jobSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

const TEXT = {
  es: (day: string, seq: string, hash: string, stamped: string) => ({
    subject: `Anclaje diario de la bitácora: ${day}`,
    text: [
      `Último evento del ${day} en la bitácora de auditoría de la red:`,
      '',
      `  Posición (seq): ${seq}`,
      `  Hash: ${hash}`,
      `  Sellado por la autoridad de sellado de tiempo: ${stamped}`,
      '',
      'Guarde este correo: si algún día la bitácora no contiene ese evento con ese hash, fue alterada.',
    ].join('\n'),
  }),
  en: (day: string, seq: string, hash: string, stamped: string) => ({
    subject: `Daily anchor of the audit trail: ${day}`,
    text: [
      `Last event of ${day} in the network's audit trail:`,
      '',
      `  Position (seq): ${seq}`,
      `  Hash: ${hash}`,
      `  Time-stamped by the time-stamping authority at: ${stamped}`,
      '',
      'Keep this e-mail: if the trail ever lacks that event with that hash, it was tampered with.',
    ].join('\n'),
  }),
};

/**
 * Daily anchoring of the audit chain (ARCHITECTURE.md §7, M2-09). Every
 * RID_AUDIT_ANCHOR_INTERVAL_SECONDS (default 3600), for each finished day (country time zone)
 * with events and no anchor yet: the hash of its last chained event is time-stamped (RFC 3161),
 * stored in the insert-only audit_anchor table, recorded as `audit.anchored` and e-mailed to the
 * regulators. The chain alone cannot show that its tail was cut; an anchor whose event is gone
 * can.
 */
@Injectable()
export class AuditAnchorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuditAnchorService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tsa: TsaClient,
    private readonly queue: QueueService,
    @Inject(MAIL_TRANSPORT) private readonly mail: MailTransport,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(ANCHOR_EMAIL_TOPIC, (data) => this.email(data));
    const seconds = Number(process.env.RID_AUDIT_ANCHOR_INTERVAL_SECONDS ?? 3600);
    const run = (): void => {
      this.anchorDue().catch((error: unknown) =>
        this.logger.error(error instanceof Error ? error.message : String(error)),
      );
    };
    run();
    this.timer = setInterval(
      run,
      (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Anchors every finished day still without an anchor; returns the days anchored. */
  async anchorDue(now = new Date()): Promise<string[]> {
    const timeZone = getCountryConfig().country.timezone;
    const today = localDay(now, timeZone);
    const last = await this.prisma.auditAnchor.findFirst({ orderBy: { day: 'desc' } });
    // Start at the day of the first chained event after the last anchor, so that days (or months)
    // without events never stall the anchoring.
    const next = await this.prisma.auditEvent.findFirst({
      where: { hash: { not: null }, ...(last ? { seq: { gt: last.lastSeq } } : {}) },
      orderBy: { seq: 'asc' },
      select: { occurredAt: true },
    });
    if (!next) return [];
    let day = firstDayToAnchor(last?.day, localDay(next.occurredAt, timeZone));
    const anchored: string[] = [];
    for (let i = 0; i < MAX_DAYS_PER_RUN && day < today; i++, day = nextDay(day)) {
      if (await this.anchorDay(day, timeZone, last?.lastSeq)) anchored.push(day);
    }
    return anchored;
  }

  /** Anchors one finished day; false when it had no new chained event (or someone else did it). */
  private async anchorDay(day: string, timeZone: string, previousSeq?: bigint): Promise<boolean> {
    const end = startOfLocalDay(nextDay(day), timeZone);
    const event = await this.prisma.auditEvent.findFirst({
      where: { hash: { not: null }, occurredAt: { lt: end } },
      orderBy: { seq: 'desc' },
      select: { seq: true, hash: true },
    });
    const latest = await this.prisma.auditAnchor.findFirst({ orderBy: { day: 'desc' } });
    const after = latest?.lastSeq ?? previousSeq;
    if (!event?.hash || (after !== undefined && event.seq <= after)) return false;
    // Stamp before the transaction: the TSA is a network call.
    const stamp = await this.tsa.stamp(Buffer.from(event.hash, 'utf8'));
    return this.prisma.$transaction(async (tx) => {
      const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${ANCHOR_LOCK}) AS locked`;
      if (!lock[0]?.locked) return false;
      if (await tx.auditAnchor.findUnique({ where: { day } })) return false;
      await tx.auditAnchor.create({
        data: {
          day,
          lastSeq: event.seq,
          lastHash: event.hash ?? '',
          tsaToken: Buffer.from(stamp.token),
          tsaGenTime: stamp.genTime,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'system', id: 'system:audit-anchor' },
        action: 'audit.anchored',
        target: { type: 'audit_anchor', id: day },
        after: {
          lastSeq: event.seq.toString(),
          lastHash: event.hash,
          tsaGenTime: stamp.genTime.toISOString(),
        },
      });
      await tx.outboxMessage.create({
        data: { topic: ANCHOR_EMAIL_TOPIC, aggregate: `audit_anchor:${day}`, payload: { day } },
      });
      return true;
    });
  }

  /** Worker for audit.anchor_email: tells every regulator the day's anchor. */
  async email(data: Record<string, unknown>): Promise<void> {
    const { day } = jobSchema.parse(data);
    const anchor = await this.prisma.auditAnchor.findUnique({ where: { day } });
    if (!anchor) return;
    const regulators = await this.prisma.user.findMany({
      where: { status: 'active', platformRoles: { some: { role: 'regulator' } } },
      select: { email: true },
    });
    const config = getCountryConfig();
    const stamped = new Intl.DateTimeFormat(config.country.locale, {
      dateStyle: 'long',
      timeStyle: 'long',
      timeZone: config.country.timezone,
    }).format(anchor.tsaGenTime);
    const message = TEXT[mailLocale(config.country.locale)](
      day,
      anchor.lastSeq.toString(),
      anchor.lastHash,
      stamped,
    );
    for (const { email } of regulators) await this.mail.send({ to: email, ...message });
  }
}
