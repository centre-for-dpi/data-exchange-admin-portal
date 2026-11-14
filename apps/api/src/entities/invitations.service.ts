import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import type { EntityRole, Invitation, MembershipSummary } from '@rid/contracts';
import { z } from 'zod';
import { type AuditActor, AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors.js';
import { MAIL_TRANSPORT, type MailTransport } from '../mail/mail.service.js';
import { MESSAGES, mailLocale } from '../mail/messages.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';

export const INVITATION_EMAIL_TOPIC = 'invitation.email';

/** Days an invitation stays valid (RID_INVITATION_TTL_DAYS, default 14). */
export function invitationExpiry(now = new Date()): Date {
  const days = Number(process.env.RID_INVITATION_TTL_DAYS ?? 14);
  const ttl = Number.isFinite(days) && days > 0 ? days : 14;
  return new Date(now.getTime() + ttl * 24 * 60 * 60 * 1000);
}

const jobSchema = z.object({ invitationId: z.uuid() });

/**
 * Invitations to an entity (ADR-0018). An invitation is addressed to an e-mail; it is shown to,
 * and can only be accepted by, a signed-in user whose verified e-mail is that address. The e-mail
 * only points to the portal: it carries no secret.
 */
@Injectable()
export class InvitationsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly outbox: OutboxService,
    @Inject(MAIL_TRANSPORT) private readonly mail: MailTransport,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(INVITATION_EMAIL_TOPIC, (data) => this.sendEmail(data));
  }

  /**
   * Creates a pending invitation inside `tx`, audits it and queues its e-mail (outbox), so the
   * e-mail goes out only if the transaction commits. A pending invitation to the same address
   * that already expired is closed first (status revoked, audited as invitation.expired).
   */
  async createInTx(
    tx: Tx,
    input: {
      entityId: string;
      email: string;
      fullName: string | null;
      roles: EntityRole[];
      invitedBy: string;
      createdBy: string;
      actor: AuditActor;
      requestId?: string;
    },
  ) {
    const stale = await tx.invitation.findMany({
      where: {
        entityId: input.entityId,
        email: input.email,
        status: 'pending',
        expiresAt: { lte: new Date() },
      },
    });
    for (const old of stale) {
      await tx.invitation.update({ where: { id: old.id }, data: { status: 'revoked' } });
      await this.audit.record(tx, {
        actor: input.actor,
        action: 'invitation.expired',
        target: { type: 'invitation', id: old.id },
        before: { status: 'pending', expiresAt: old.expiresAt.toISOString() },
        after: { status: 'revoked' },
        requestId: input.requestId,
      });
    }
    const invitation = await tx.invitation.create({
      data: {
        entityId: input.entityId,
        email: input.email,
        fullName: input.fullName,
        roles: input.roles,
        expiresAt: invitationExpiry(),
        invitedBy: input.invitedBy,
        createdBy: input.createdBy,
      },
    });
    await this.audit.record(tx, {
      actor: input.actor,
      action: 'invitation.created',
      target: { type: 'invitation', id: invitation.id },
      after: {
        entityId: input.entityId,
        email: input.email,
        roles: invitation.roles,
        expiresAt: invitation.expiresAt.toISOString(),
      },
      requestId: input.requestId,
    });
    await this.outbox.enqueue(tx, {
      topic: INVITATION_EMAIL_TOPIC,
      aggregate: `invitation:${invitation.id}`,
      payload: { invitationId: invitation.id },
    });
    return invitation;
  }

  private static view(row: {
    id: string;
    roles: EntityRole[];
    expiresAt: Date;
    createdAt: Date;
    entity: { id: string; slug: string; shortName: string; legalName: string };
  }): Invitation {
    return {
      id: row.id,
      entity: {
        id: row.entity.id,
        slug: row.entity.slug,
        shortName: row.entity.shortName,
        legalName: row.entity.legalName,
      },
      roles: row.roles,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Pending, unexpired invitations to the caller's e-mail, for active entities. */
  async mine(principal: Principal): Promise<{ items: Invitation[] }> {
    if (!principal.emailVerified) return { items: [] };
    const rows = await this.prisma.invitation.findMany({
      where: {
        email: principal.email.toLowerCase(),
        status: 'pending',
        expiresAt: { gt: new Date() },
        entity: { status: 'active' },
      },
      include: { entity: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return { items: rows.map((row) => InvitationsService.view(row)) };
  }

  /**
   * The invitation, if it is addressed to the caller. An invitation to another address is a 404:
   * its existence is not revealed.
   */
  private async loadOwn(invitationId: string, principal: Principal) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      include: { entity: true },
    });
    if (!invitation || invitation.email !== principal.email.toLowerCase()) {
      throw new NotFoundError('Invitation');
    }
    if (!principal.emailVerified) {
      throw new ForbiddenError('Verify your e-mail address before answering an invitation');
    }
    if (invitation.status !== 'pending') {
      throw new ConflictError(`The invitation was already ${invitation.status}`);
    }
    if (invitation.expiresAt <= new Date()) throw new ConflictError('The invitation has expired');
    if (invitation.entity.status !== 'active') {
      throw new ConflictError('The entity is not active');
    }
    return invitation;
  }

  async accept(
    invitationId: string,
    principal: Principal,
    requestId?: string,
  ): Promise<MembershipSummary> {
    const invitation = await this.loadOwn(invitationId, principal);
    const actor = { type: 'user' as const, id: principal.keycloakSub };
    const roles = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.invitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date(), respondedBy: principal.userId },
      });
      if (changed.count === 0) throw new ConflictError('The invitation changed meanwhile');
      await this.audit.record(tx, {
        actor,
        action: 'invitation.accepted',
        target: { type: 'invitation', id: invitationId },
        before: { status: 'pending' },
        after: { status: 'accepted', userId: principal.userId },
        requestId,
      });

      const existing = await tx.membership.findUnique({
        where: { userId_entityId: { userId: principal.userId, entityId: invitation.entityId } },
      });
      if (!existing) {
        const created = await tx.membership.create({
          data: {
            userId: principal.userId,
            entityId: invitation.entityId,
            roles: invitation.roles,
            status: 'active',
            invitedBy: invitation.invitedBy,
            createdBy: principal.userId,
          },
        });
        await this.audit.record(tx, {
          actor,
          action: 'membership.created',
          target: { type: 'membership', id: created.id },
          after: {
            userId: principal.userId,
            entityId: invitation.entityId,
            roles: created.roles,
            status: 'active',
            invitationId,
          },
          requestId,
        });
        return created.roles;
      }
      // Already a member (or a revoked one): the invitation adds its roles and reactivates.
      const merged = [
        ...new Set([...(existing.status === 'active' ? existing.roles : []), ...invitation.roles]),
      ];
      await tx.membership.update({
        where: { id: existing.id },
        data: { roles: merged, status: 'active' },
      });
      await this.audit.record(tx, {
        actor,
        action: 'membership.updated',
        target: { type: 'membership', id: existing.id },
        before: { roles: existing.roles, status: existing.status },
        after: { roles: merged, status: 'active', invitationId },
        requestId,
      });
      return merged;
    });
    return {
      entity: {
        id: invitation.entity.id,
        slug: invitation.entity.slug,
        shortName: invitation.entity.shortName,
      },
      roles,
    };
  }

  async decline(invitationId: string, principal: Principal, requestId?: string): Promise<void> {
    await this.loadOwn(invitationId, principal);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.invitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'declined', respondedAt: new Date(), respondedBy: principal.userId },
      });
      if (changed.count === 0) throw new ConflictError('The invitation changed meanwhile');
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub },
        action: 'invitation.declined',
        target: { type: 'invitation', id: invitationId },
        before: { status: 'pending' },
        after: { status: 'declined', userId: principal.userId },
        requestId,
      });
    });
  }

  /**
   * Worker for invitation.email. Skips invitations that are no longer pending. Delivery is
   * at-least-once: a retry after a lost acknowledgement can send the same e-mail twice.
   */
  async sendEmail(data: Record<string, unknown>): Promise<void> {
    const { invitationId } = jobSchema.parse(data);
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      include: { entity: true },
    });
    if (!invitation || invitation.status !== 'pending') return;
    const config = getCountryConfig();
    const locale = mailLocale(config.country.locale);
    const webUrl = (process.env.RID_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    // Spanish is the default locale and has no prefix (apps/web/src/i18n/routing.ts).
    const link = `${webUrl}${locale === 'es' ? '' : `/${locale}`}/invitations`;
    const expires = new Intl.DateTimeFormat(config.country.locale, {
      dateStyle: 'long',
      timeZone: config.country.timezone,
    }).format(invitation.expiresAt);
    const message = MESSAGES[locale].invitation({
      product: config.branding.productName,
      entityShortName: invitation.entity.shortName,
      entityLegalName: invitation.entity.legalName,
      name: invitation.fullName,
      email: invitation.email,
      roles: invitation.roles,
      link,
      expires,
    });
    await this.mail.send({ to: invitation.email, ...message });
    this.logger.log(`Invitation ${invitationId} e-mailed`);
  }
}
