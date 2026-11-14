import { Injectable } from '@nestjs/common';
import type { EntityStatus, SubscriptionStatus } from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { assertTransition as assertVersionTransition } from '../domain/api-version/state-machine.js';
import { assertTransition } from '../domain/entity/state-machine.js';
import { LIVE_STATUSES } from '../domain/subscription/state-machine.js';
import { ApisService } from '../apis/apis.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';

const PENDING: SubscriptionStatus[] = ['pending_provider', 'info_requested', 'pending_regulator'];

/**
 * Suspension, reactivation and offboarding of entities by the operator (SPEC.md §4.1, M2-11).
 * The gateway learns it from the OPA bundle, rebuilt from the database: a suspended entity's
 * applications are denied (app_suspended), and with `providerSuspended` its APIs stop serving
 * other entities. Offboarding is final: subscriptions on both sides are closed, its versions
 * retired (routes removed), memberships and pending invitations revoked. All audited.
 */
@Injectable()
export class EntityStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly apis: ApisService,
  ) {}

  async list(status?: EntityStatus) {
    const rows = await this.prisma.entity.findMany({
      where: { status: status ? status : { in: ['active', 'suspended', 'offboarded'] } },
      orderBy: { shortName: 'asc' },
      take: 500,
      include: {
        _count: {
          select: {
            memberships: { where: { status: 'active' } },
            apis: { where: { status: 'published' } },
          },
        },
      },
    });
    const live = await this.prisma.subscription.groupBy({
      by: ['applicationId'],
      where: { status: { in: [...LIVE_STATUSES] } },
      _count: { _all: true },
    });
    const apps = await this.prisma.application.findMany({
      where: { id: { in: live.map((l) => l.applicationId) } },
      select: { id: true, entityId: true },
    });
    const perEntity = new Map<string, number>();
    for (const l of live) {
      const entityId = apps.find((a) => a.id === l.applicationId)?.entityId;
      if (entityId) perEntity.set(entityId, (perEntity.get(entityId) ?? 0) + l._count._all);
    }
    return {
      items: rows.map((e) => ({
        id: e.id,
        slug: e.slug,
        shortName: e.shortName,
        legalName: e.legalName,
        status: e.status,
        providerSuspended: e.providerSuspended,
        counts: {
          members: e._count.memberships,
          publishedApis: e._count.apis,
          liveSubscriptions: perEntity.get(e.id) ?? 0,
        },
      })),
    };
  }

  private async load(entityId: string) {
    const entity = await this.prisma.entity.findUnique({ where: { id: entityId } });
    // Distinct from the guard's "Entity not found": here the caller may act, the id is unknown.
    if (!entity) throw new NotFoundError('Network entity');
    return entity;
  }

  private async decide(
    tx: Tx,
    entityId: string,
    from: EntityStatus,
    to: EntityStatus,
    principal: Principal,
    decision: 'suspended' | 'reactivated' | 'offboarded',
    comment: string | null,
    extra: { providerSuspended: boolean },
    requestId?: string,
  ): Promise<void> {
    assertTransition(from, to);
    const changed = await tx.entity.updateMany({
      where: { id: entityId, status: from },
      data: { status: to, providerSuspended: extra.providerSuspended },
    });
    if (changed.count === 0) throw new ConflictError('The entity changed meanwhile; reload it');
    await tx.entityReview.create({
      data: {
        entityId,
        decision,
        reviewerRole: 'platform_admin',
        reviewerId: principal.userId,
        comment,
      },
    });
    await this.audit.record(tx, {
      actor: { type: 'user', id: principal.keycloakSub },
      action: `entity.${decision}`,
      target: { type: 'entity', id: entityId },
      before: { status: from },
      after: { status: to, providerSuspended: extra.providerSuspended, comment },
      requestId,
    });
    await this.outbox.enqueue(tx, {
      topic: POLICY_SYNC_TOPIC,
      aggregate: `entity:${entityId}`,
      payload: { reason: decision },
    });
  }

  async suspend(
    entityId: string,
    principal: Principal,
    input: { comment: string; alsoAsProvider: boolean },
    requestId?: string,
  ) {
    const before = await this.load(entityId);
    await this.prisma.$transaction((tx) =>
      this.decide(
        tx,
        entityId,
        before.status,
        'suspended',
        principal,
        'suspended',
        input.comment,
        {
          providerSuspended: input.alsoAsProvider,
        },
        requestId,
      ),
    );
    return this.list();
  }

  async reactivate(entityId: string, principal: Principal, comment?: string, requestId?: string) {
    const before = await this.load(entityId);
    await this.prisma.$transaction((tx) =>
      this.decide(
        tx,
        entityId,
        before.status,
        'active',
        principal,
        'reactivated',
        comment ?? null,
        {
          providerSuspended: false,
        },
        requestId,
      ),
    );
    return this.list();
  }

  async offboard(entityId: string, principal: Principal, comment: string, requestId?: string) {
    const before = await this.load(entityId);
    await this.prisma.$transaction(
      async (tx) => {
        await this.decide(
          tx,
          entityId,
          before.status,
          'offboarded',
          principal,
          'offboarded',
          comment,
          {
            providerSuspended: true,
          },
          requestId,
        );
        const actor = { type: 'system' as const, id: 'system:entity-offboarding' };

        // Live subscriptions, as consumer and as provider.
        const subscriptions = await tx.subscription.findMany({
          where: {
            status: { in: [...LIVE_STATUSES] },
            OR: [{ application: { entityId } }, { apiVersion: { api: { entityId } } }],
          },
          select: { id: true, status: true },
        });
        for (const s of subscriptions) {
          const to: SubscriptionStatus =
            s.status === 'info_requested'
              ? 'withdrawn'
              : PENDING.includes(s.status)
                ? 'rejected'
                : 'revoked';
          const moved = await tx.subscription.updateMany({
            where: { id: s.id, status: s.status },
            data: { status: to },
          });
          if (moved.count === 0) continue;
          await tx.subscriptionDecision.create({
            data: {
              subscriptionId: s.id,
              decision: to,
              decidedBy: principal.userId,
              decidedByEntityId: null,
              comment: 'The entity was offboarded',
            },
          });
          await this.audit.record(tx, {
            actor,
            action: `subscription.${to}`,
            target: { type: 'subscription', id: s.id },
            before: { status: s.status },
            after: { status: to, reason: 'entity_offboarded', entityId },
            requestId,
          });
        }

        // Its versions leave the gateway.
        const versions = await tx.apiVersion.findMany({
          where: { api: { entityId }, status: { in: ['published', 'deprecated'] } },
          select: { id: true, apiId: true, status: true },
        });
        const now = new Date();
        for (const v of versions) {
          assertVersionTransition(v.status, 'retired');
          await tx.apiVersion.update({
            where: { id: v.id },
            data: { status: 'retired', retiredAt: now },
          });
          await this.audit.record(tx, {
            actor,
            action: 'api_version.retired',
            target: { type: 'api_version', id: v.id },
            before: { status: v.status },
            after: { status: 'retired', reason: 'entity_offboarded' },
            requestId,
          });
          await this.outbox.enqueue(tx, {
            topic: GATEWAY_SYNC_TOPIC,
            aggregate: `apiVersion:${v.id}`,
            payload: { reason: 'retired' },
          });
        }
        for (const apiId of new Set(versions.map((v) => v.apiId))) {
          await this.apis.refreshApiStatus(tx, apiId);
        }

        // Nobody acts for it any more.
        const memberships = await tx.membership.findMany({
          where: { entityId, status: { not: 'revoked' } },
          select: { id: true, status: true, roles: true },
        });
        for (const m of memberships) {
          await tx.membership.update({ where: { id: m.id }, data: { status: 'revoked' } });
          await this.audit.record(tx, {
            actor,
            action: 'membership.revoked',
            target: { type: 'membership', id: m.id },
            before: { status: m.status, roles: m.roles },
            after: { status: 'revoked', reason: 'entity_offboarded' },
            requestId,
          });
        }
        const invitations = await tx.invitation.findMany({
          where: { entityId, status: 'pending' },
          select: { id: true },
        });
        for (const { id } of invitations) {
          await tx.invitation.update({
            where: { id },
            data: { status: 'revoked', respondedAt: now },
          });
          await this.audit.record(tx, {
            actor,
            action: 'invitation.revoked',
            target: { type: 'invitation', id },
            before: { status: 'pending' },
            after: { status: 'revoked', reason: 'entity_offboarded' },
            requestId,
          });
        }
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return this.list();
  }
}
