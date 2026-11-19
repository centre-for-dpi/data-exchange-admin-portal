import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { getCountryConfig } from '@den/config';
import {
  NOTIFICATION_KINDS,
  type Notification,
  type NotificationKind,
  notificationKindSchema,
  notificationParamsSchema,
} from '@den/contracts';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { NotFoundError } from '../common/errors.js';
import { MAIL_TRANSPORT, type MailTransport } from '../mail/mail.service.js';
import { mailLocale } from '../mail/messages.js';
import {
  NOTIFICATION_FOOTER,
  NOTIFICATION_SUBJECTS,
  NOTIFICATION_TEXTS,
} from '../mail/notification-messages.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { resolveNotification } from './notification-rules.js';
import { NOTIFICATION_TOPIC } from './notifying-actions.js';

const jobSchema = z.object({ seq: z.string().regex(/^\d+$/) });
const payloadSchema = z.object({ params: notificationParamsSchema, link: z.string() });

/**
 * Notifications in the portal and by e-mail (SPEC.md §7, M2-08). AuditService queues every
 * notifying event in its own transaction; this worker resolves the recipients, stores one row per
 * event and person (unique: retries do not duplicate) and e-mails those who want it. Security
 * kinds are always e-mailed. The actor of the event is never notified of their own action.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    @Inject(MAIL_TRANSPORT) private readonly mail: MailTransport,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(NOTIFICATION_TOPIC, (data) => this.dispatch(data));
  }

  /** Worker for notification.dispatch: { seq } of the audit event. */
  async dispatch(data: Record<string, unknown>): Promise<number> {
    const seq = BigInt(jobSchema.parse(data).seq);
    const event = await this.prisma.auditEvent.findUnique({ where: { seq } });
    if (!event) return 0;
    const resolved = await resolveNotification(this.prisma, event);
    if (!resolved) return 0;
    const actor =
      event.actorType === 'user'
        ? await this.prisma.user.findUnique({ where: { keycloakSub: event.actorId } })
        : null;
    const recipients = await this.prisma.user.findMany({
      where: {
        id: { in: [...new Set(resolved.recipients)].filter((id) => id !== actor?.id) },
        status: 'active',
      },
      select: { id: true },
    });
    if (recipients.length > 0) {
      await this.prisma.notification.createMany({
        data: recipients.map((r) => ({
          userId: r.id,
          kind: resolved.kind,
          payload: { params: resolved.params, link: resolved.link },
          sourceSeq: seq,
        })),
        skipDuplicates: true,
      });
    }
    await this.sendPendingEmails(seq);
    return recipients.length;
  }

  /** E-mails the rows of an event not e-mailed yet, honouring preferences; marks them sent. */
  private async sendPendingEmails(seq: bigint): Promise<void> {
    const rows = await this.prisma.notification.findMany({
      where: { sourceSeq: seq, emailSentAt: null },
      include: { user: { include: { notificationPreferences: true } } },
    });
    const config = getCountryConfig();
    const locale = mailLocale(config.country.locale);
    const webUrl = (process.env.DEN_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    const prefix = locale === 'es' ? '' : `/${locale}`;
    const day = (iso?: string) =>
      iso
        ? new Intl.DateTimeFormat(config.country.locale, {
            dateStyle: 'long',
            timeZone: config.country.timezone,
          }).format(new Date(iso))
        : '';
    for (const row of rows) {
      const kind = notificationKindSchema.parse(row.kind);
      const rule = NOTIFICATION_KINDS[kind];
      const optedOut = row.user.notificationPreferences.some((p) => p.kind === kind && !p.email);
      if (!rule.email || (optedOut && !rule.security)) continue;
      const { params, link } = payloadSchema.parse(row.payload);
      const title = NOTIFICATION_TEXTS[locale][kind](params, day(params.date));
      await this.mail.send({
        to: row.user.email,
        subject: NOTIFICATION_SUBJECTS[locale][kind],
        text: [
          title,
          '',
          `${webUrl}${prefix}${link}`,
          '',
          NOTIFICATION_FOOTER[locale](`${webUrl}${prefix}/notifications`),
        ].join('\n'),
      });
      await this.prisma.notification.update({
        where: { id: row.id },
        data: { emailSentAt: new Date() },
      });
    }
    if (rows.length) this.logger.log(`Notifications of event ${seq} dispatched`);
  }

  private static view(row: {
    id: string;
    kind: string;
    payload: unknown;
    createdAt: Date;
    readAt: Date | null;
  }): Notification {
    const { params, link } = payloadSchema.parse(row.payload);
    return {
      id: row.id,
      kind: notificationKindSchema.parse(row.kind),
      params,
      link,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    };
  }

  async list(
    principal: Principal,
    query: { cursor?: string; limit: number; unread?: 'true' | 'false' },
  ) {
    const where = {
      userId: principal.userId,
      ...(query.unread === 'true' ? { readAt: null } : {}),
    };
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.prisma.notification.count({ where: { userId: principal.userId, readAt: null } }),
    ]);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((r) => NotificationsService.view(r)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      unread,
    };
  }

  /** Marks one of the caller's notifications read; anyone else's is a 404. */
  async markRead(principal: Principal, notificationId: string): Promise<Notification> {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId: principal.userId, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId: principal.userId },
    });
    if (!row) throw new NotFoundError('Notification');
    return NotificationsService.view(row);
  }

  async markAllRead(principal: Principal): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId: principal.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  async preferences(principal: Principal) {
    const saved = await this.prisma.notificationPreference.findMany({
      where: { userId: principal.userId },
    });
    return {
      items: (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).map((kind) => {
        const rule = NOTIFICATION_KINDS[kind];
        const locked = rule.security || !rule.email;
        return {
          kind,
          email:
            rule.email && (rule.security || (saved.find((p) => p.kind === kind)?.email ?? true)),
          locked,
        };
      }),
    };
  }

  /** Saves e-mail choices; locked kinds (security, or without e-mail) are ignored. */
  async updatePreferences(
    principal: Principal,
    items: Array<{ kind: NotificationKind; email: boolean }>,
    requestId?: string,
  ) {
    const editable = items.filter(({ kind }) => {
      const rule = NOTIFICATION_KINDS[kind];
      return rule.email && !rule.security;
    });
    if (editable.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const { kind, email } of editable) {
          await tx.notificationPreference.upsert({
            where: { userId_kind: { userId: principal.userId, kind } },
            create: { userId: principal.userId, kind, email },
            update: { email },
          });
        }
        await this.audit.record(tx, {
          actor: { type: 'user', id: principal.keycloakSub },
          action: 'notification_preference.updated',
          target: { type: 'user', id: principal.userId },
          after: { email: Object.fromEntries(editable.map((i) => [i.kind, i.email])) },
          requestId,
        });
      });
    }
    return this.preferences(principal);
  }
}
