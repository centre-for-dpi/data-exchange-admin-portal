import { Injectable } from '@nestjs/common';
import type { RegulatorQueue, ReviewDetail, SubscriptionDetail } from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors.js';
import { assertTransition as assertVersionTransition } from '../domain/api-version/state-machine.js';
import { requiresRegulator } from '../domain/approval.js';
import { assertEntityActive } from '../domain/entity/active.js';
import { assertTransition as assertSubscriptionTransition } from '../domain/subscription/state-machine.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { POLICY_SYNC_TOPIC, SubscriptionsService } from '../subscriptions/subscriptions.service.js';

const actorOf = (principal: Principal) => ({ type: 'user' as const, id: principal.keycloakSub });

/**
 * The regulator's step (SPEC.md §4.2 step 3, §4.4 step 3; M2-04). With
 * features.approval.regulatorForSensitive, a sensitive publication waits in approved_operator and
 * a sensitive access request in pending_regulator until the regulator decides. Approving
 * publishes the version or approves the request and enqueues the gateway/policy sync; the
 * gateway is never called from here (ADR-0007).
 */
@Injectable()
export class RegulatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly reviews: ReviewsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async queue(): Promise<RegulatorQueue> {
    const [versions, requests] = await Promise.all([
      this.prisma.apiVersion.findMany({
        where: { status: 'approved_operator' },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: 200,
        include: {
          api: { include: { entity: true } },
          reviews: { where: { decision: 'approved' }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.subscription.findMany({
        where: { status: 'pending_regulator' },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: 200,
        include: {
          application: { include: { entity: true } },
          apiVersion: { include: { api: { include: { entity: true } } } },
        },
      }),
    ]);
    const ref = (e: { id: string; slug: string; shortName: string }) => ({
      id: e.id,
      slug: e.slug,
      shortName: e.shortName,
    });
    return {
      apiVersions: versions.map((v) => ({
        versionId: v.id,
        version: v.version,
        operatorApprovedAt: v.reviews[0]?.createdAt.toISOString() ?? null,
        api: { id: v.api.id, name: v.api.name, classification: v.api.classification },
        entity: ref(v.api.entity),
      })),
      subscriptions: requests.map((s) => ({
        id: s.id,
        requestedAt: s.createdAt.toISOString(),
        api: {
          id: s.apiVersion.api.id,
          name: s.apiVersion.api.name,
          classification: s.apiVersion.api.classification,
        },
        version: { id: s.apiVersion.id, version: s.apiVersion.version },
        provider: ref(s.apiVersion.api.entity),
        consumer: ref(s.application.entity),
        purposeCode: s.purposeCode,
      })),
    };
  }

  private static assertNotMember(principal: Principal, entityIds: string[]): void {
    if (principal.memberships.some((m) => entityIds.includes(m.entityId))) {
      throw new ForbiddenError('You cannot decide on something an entity of yours is part of');
    }
  }

  // ------------------------------------------------------------------------------------------
  // API versions
  // ------------------------------------------------------------------------------------------

  private async loadVersion(versionId: string) {
    const version = await this.prisma.apiVersion.findUnique({
      where: { id: versionId },
      include: { api: true, reviews: true },
    });
    if (!version) throw new NotFoundError('API version');
    return version;
  }

  /**
   * Separation of duties: the regulator cannot decide on a version they wrote, submitted or
   * already approved as operator, nor on one of an entity they belong to.
   */
  private static assertImpartialOnVersion(
    principal: Principal,
    v: {
      createdBy: string;
      submittedBy: string | null;
      api: { entityId: string; createdBy: string };
      reviews: Array<{ reviewerId: string }>;
    },
  ): void {
    const involved = [
      v.createdBy,
      v.submittedBy,
      v.api.createdBy,
      ...v.reviews.map((r) => r.reviewerId),
    ];
    if (involved.includes(principal.userId)) {
      throw new ForbiddenError('You cannot decide on a version you created, submitted or reviewed');
    }
    RegulatorService.assertNotMember(principal, [v.api.entityId]);
  }

  async approveVersion(
    versionId: string,
    principal: Principal,
    comment: string | undefined,
    requestId?: string,
  ): Promise<ReviewDetail> {
    const before = await this.loadVersion(versionId);
    assertVersionTransition(before.status, 'approved_regulator');
    if (!requiresRegulator(before.api.classification, before.exposedFields)) {
      throw new ConflictError('This version does not need the regulator');
    }
    RegulatorService.assertImpartialOnVersion(principal, before);
    await assertEntityActive(this.prisma, before.api.entityId);

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: 'approved_operator' },
        data: { status: 'published', publishedAt: new Date() },
      });
      if (changed.count === 0) throw new ConflictError('The version changed meanwhile; reload it');
      assertVersionTransition('approved_regulator', 'published');
      await tx.apiVersionReview.create({
        data: {
          apiVersionId: versionId,
          decision: 'approved',
          reviewerRole: 'regulator',
          reviewerId: principal.userId,
          comment: comment ?? null,
        },
      });
      await this.audit.record(tx, {
        actor: actorOf(principal),
        action: 'api_version.approved_regulator',
        target: { type: 'api_version', id: versionId },
        before: { status: before.status },
        after: {
          status: 'approved_regulator',
          reviewerRole: 'regulator',
          comment: comment ?? null,
        },
        requestId,
      });
      if (before.api.status !== 'published') {
        await tx.api.update({ where: { id: before.apiId }, data: { status: 'published' } });
      }
      await this.outbox.enqueue(tx, {
        topic: GATEWAY_SYNC_TOPIC,
        aggregate: `apiVersion:${versionId}`,
        payload: { reason: 'published' },
      });
      await this.audit.record(tx, {
        actor: actorOf(principal),
        action: 'api_version.published',
        target: { type: 'api_version', id: versionId },
        after: { status: 'published', basePath: before.basePath },
        requestId,
      });
    });
    return this.reviews.detail(versionId);
  }

  /** Sends the version back to the provider with the regulator's reason. */
  async returnVersion(
    versionId: string,
    principal: Principal,
    comment: string,
    requestId?: string,
  ): Promise<ReviewDetail> {
    const before = await this.loadVersion(versionId);
    assertVersionTransition(before.status, 'changes_requested');
    if (before.status !== 'approved_operator') {
      throw new ConflictError('Only versions waiting for the regulator can be sent back here');
    }
    RegulatorService.assertImpartialOnVersion(principal, before);

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: 'approved_operator' },
        data: { status: 'changes_requested' },
      });
      if (changed.count === 0) throw new ConflictError('The version changed meanwhile; reload it');
      await tx.apiVersionReview.create({
        data: {
          apiVersionId: versionId,
          decision: 'changes_requested',
          reviewerRole: 'regulator',
          reviewerId: principal.userId,
          comment,
        },
      });
      await this.audit.record(tx, {
        actor: actorOf(principal),
        action: 'api_version.changes_requested',
        target: { type: 'api_version', id: versionId },
        before: { status: before.status },
        after: { status: 'changes_requested', reviewerRole: 'regulator', comment },
        requestId,
      });
    });
    return this.reviews.detail(versionId);
  }

  // ------------------------------------------------------------------------------------------
  // Access requests
  // ------------------------------------------------------------------------------------------

  private async loadSubscription(subscriptionId: string) {
    const s = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        application: true,
        apiVersion: { include: { api: true } },
        decisions: true,
      },
    });
    if (!s) throw new NotFoundError('Access request');
    return s;
  }

  /**
   * Separation of duties: not the requester nor the creator of the application, not the data
   * steward who approved it, and not a member of the provider or consumer entity.
   */
  private static assertImpartialOnSubscription(
    principal: Principal,
    s: Awaited<ReturnType<RegulatorService['loadSubscription']>>,
  ): void {
    const involved = [
      s.requestedBy,
      s.application.createdBy,
      ...s.decisions.map((d) => d.decidedBy),
    ];
    if (involved.includes(principal.userId)) {
      throw new ForbiddenError('You cannot decide on an access request you made or decided');
    }
    RegulatorService.assertNotMember(principal, [
      s.application.entityId,
      s.apiVersion.api.entityId,
    ]);
  }

  async approveSubscription(
    subscriptionId: string,
    principal: Principal,
    comment: string | undefined,
    requestId?: string,
  ): Promise<SubscriptionDetail> {
    const before = await this.loadSubscription(subscriptionId);
    if (before.status !== 'pending_regulator') {
      throw new ConflictError(`The request is ${before.status}, not waiting for the regulator`);
    }
    assertSubscriptionTransition(before.status, 'approved');
    RegulatorService.assertImpartialOnSubscription(principal, before);

    // Validity counts from the final decision: keep the length the data steward granted.
    const now = new Date();
    const validUntil = new Date(
      now.getTime() + (before.validUntil.getTime() - before.validFrom.getTime()),
    );
    await this.prisma.$transaction(async (tx) => {
      await this.subscriptions.lockRenewedStillActive(tx, before);
      const changed = await tx.subscription.updateMany({
        where: { id: subscriptionId, status: 'pending_regulator' },
        data: { status: 'approved', validFrom: now, validUntil },
      });
      if (changed.count === 0) throw new ConflictError('The request changed meanwhile; reload it');
      await tx.subscriptionDecision.create({
        data: {
          subscriptionId,
          decision: 'approved',
          decidedBy: principal.userId,
          decidedByEntityId: null,
          comment: comment ?? null,
        },
      });
      await this.audit.record(tx, {
        actor: actorOf(principal),
        action: 'subscription.approved_regulator',
        target: { type: 'subscription', id: subscriptionId },
        before: { status: before.status },
        after: {
          status: 'approved',
          validFrom: now.toISOString(),
          validUntil: validUntil.toISOString(),
          comment: comment ?? null,
        },
        requestId,
      });
      await this.outbox.enqueue(tx, {
        topic: POLICY_SYNC_TOPIC,
        aggregate: `subscription:${subscriptionId}`,
        payload: { reason: 'approved' },
      });
    });
    return this.subscriptions.getForProvider(before.apiVersion.api.entityId, subscriptionId);
  }

  async rejectSubscription(
    subscriptionId: string,
    principal: Principal,
    comment: string,
    requestId?: string,
  ): Promise<SubscriptionDetail> {
    const before = await this.loadSubscription(subscriptionId);
    if (before.status !== 'pending_regulator') {
      throw new ConflictError(`The request is ${before.status}, not waiting for the regulator`);
    }
    assertSubscriptionTransition(before.status, 'rejected');
    RegulatorService.assertImpartialOnSubscription(principal, before);

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.subscription.updateMany({
        where: { id: subscriptionId, status: 'pending_regulator' },
        data: { status: 'rejected' },
      });
      if (changed.count === 0) throw new ConflictError('The request changed meanwhile; reload it');
      await tx.subscriptionDecision.create({
        data: {
          subscriptionId,
          decision: 'rejected',
          decidedBy: principal.userId,
          decidedByEntityId: null,
          comment,
        },
      });
      await this.audit.record(tx, {
        actor: actorOf(principal),
        action: 'subscription.rejected_regulator',
        target: { type: 'subscription', id: subscriptionId },
        before: { status: before.status },
        after: { status: 'rejected', comment },
        requestId,
      });
    });
    return this.subscriptions.getForProvider(before.apiVersion.api.entityId, subscriptionId);
  }
}
