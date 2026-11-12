import { Injectable } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import type {
  ApproveSubscriptionInput,
  Classification,
  CreateSubscriptionInput,
  RejectSubscriptionInput,
  RevokeSubscriptionInput,
  SubscriptionDetail,
  SubscriptionListQuery,
  SubscriptionStatus,
  SubscriptionSummary,
} from '@rid/contracts';
import {
  approveSubscriptionSchema,
  createSubscriptionSchema,
  rejectSubscriptionSchema,
  revokeSubscriptionSchema,
} from '@rid/contracts';
import { listOperations } from '../apis/lint/openapi-lint.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import {
  ConflictError,
  type FieldError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../common/errors.js';
import { requiresRegulator } from '../domain/approval.js';
import { assertTransition } from '../domain/subscription/state-machine.js';
import { Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';

/** Outbox topic consumed by the OPA bundle publisher (M1-09): it turns `approved` into `active`. */
export const POLICY_SYNC_TOPIC = 'policy.sync';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

const INCLUDE = {
  application: { include: { entity: true } },
  apiVersion: { include: { api: { include: { entity: true } } } },
  purpose: true,
  decisions: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.SubscriptionInclude;

type Row = Prisma.SubscriptionGetPayload<{ include: typeof INCLUDE }>;

/** Adds calendar months in UTC, clamping to the last day of a shorter month. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

const maxValidityMonths = (classification: Classification): number =>
  getCountryConfig().subscriptionMaxValidityMonths[classification];

/** Personal and sensitive data require identifying the official behind each call (SPEC.md §5). */
const endUserRequired = (classification: Classification): boolean =>
  classification === 'personal' || classification === 'sensitive';

const operationsOf = (spec: unknown) => listOperations(spec as Record<string, unknown>);

const readOnlyOperations = (spec: unknown): string[] =>
  operationsOf(spec)
    .filter((o) => READ_ONLY_METHODS.has(o.method))
    .map((o) => o.operationId);

/**
 * The provider decides only requests waiting for it; the regulator step (pending_regulator) belongs
 * to the regulator (M2-04).
 */
function assertProviderStep(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (from !== 'pending_provider') throw new InvalidTransitionError('subscription', from, to);
  assertTransition(from, to);
}

const entityRef = (e: { id: string; slug: string; shortName: string }) => ({
  id: e.id,
  slug: e.slug,
  shortName: e.shortName,
});

function snapshot(s: {
  status: string;
  approvedOperations: string[];
  validFrom: Date;
  validUntil: Date;
  rateLimitPerMinute: number | null;
}) {
  return {
    status: s.status,
    approvedOperations: s.approvedOperations,
    validFrom: s.validFrom.toISOString(),
    validUntil: s.validUntil.toISOString(),
    rateLimitPerMinute: s.rateLimitPerMinute,
  };
}

/**
 * Access requests (SPEC.md §4.4, M1-07). The consumer entity's app developer asks for access; the
 * provider entity's data steward approves (only narrowing what was asked) or rejects. Approving
 * enqueues the policy sync; the gateway learns about it from the OPA bundle (M1-09), never from a
 * call made here.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private summary(s: Row): SubscriptionSummary {
    const { api } = s.apiVersion;
    return {
      id: s.id,
      status: s.status,
      purpose: {
        code: s.purpose.code,
        name: s.purpose.name as SubscriptionSummary['purpose']['name'],
      },
      application: {
        id: s.application.id,
        name: s.application.name,
        clientId: s.application.keycloakClientId,
        entity: entityRef(s.application.entity),
      },
      api: {
        id: api.id,
        name: api.name,
        classification: api.classification,
        entity: entityRef(api.entity),
      },
      version: {
        id: s.apiVersion.id,
        version: s.apiVersion.version,
        basePath: s.apiVersion.basePath,
      },
      requestedAt: s.createdAt.toISOString(),
      validFrom: s.validFrom.toISOString(),
      validUntil: s.validUntil.toISOString(),
    };
  }

  private detail(s: Row): SubscriptionDetail {
    const { api } = s.apiVersion;
    return {
      ...this.summary(s),
      purposeDetail: s.purposeDetail,
      legalBasisText: s.legalBasisText,
      legalReference: s.legalReference,
      operations: operationsOf(s.apiVersion.openapiSpec),
      requestedOperations: s.requestedOperations,
      approvedOperations: s.approvedOperations,
      effectiveRequestedOperations: this.effectiveRequested(s),
      requestedValidityMonths: s.requestedValidityMonths,
      maxValidityMonths: maxValidityMonths(api.classification),
      requestedRateLimit: s.requestedRateLimit,
      rateLimitPerMinute: s.rateLimitPerMinute,
      defaultRateLimit: s.apiVersion.defaultRateLimit,
      endUserIdentificationRequired: s.endUserIdentificationRequired,
      requiresRegulator: requiresRegulator(api.classification, s.apiVersion.exposedFields),
      // Who decided is in the audit trail; the request only says on whose behalf.
      decisions: s.decisions.map((d) => ({
        decision: d.decision,
        by: d.decidedByEntityId ? ('provider' as const) : ('platform' as const),
        comment: d.comment,
        decidedAt: d.createdAt.toISOString(),
      })),
    };
  }

  private effectiveRequested(s: Row): string[] {
    return s.requestedOperations.length > 0
      ? s.requestedOperations
      : readOnlyOperations(s.apiVersion.openapiSpec);
  }

  private async page(where: Prisma.SubscriptionWhereInput, query: SubscriptionListQuery) {
    const rows = await this.prisma.subscription.findMany({
      where: { ...where, ...(query.status ? { status: query.status } : {}) },
      include: INCLUDE,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, query.limit);
    return {
      items: items.map((s) => this.summary(s)),
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Consumer side: /entities/:entityId/subscriptions (the entity owns the application)
  // -------------------------------------------------------------------------------------------

  listForConsumer(entityId: string, query: SubscriptionListQuery) {
    return this.page({ application: { entityId } }, query);
  }

  async getForConsumer(entityId: string, subscriptionId: string): Promise<SubscriptionDetail> {
    const row = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, application: { entityId } },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Subscription');
    return this.detail(row);
  }

  async request(
    entityId: string,
    principal: Principal,
    input: CreateSubscriptionInput,
    requestId?: string,
  ): Promise<SubscriptionDetail> {
    const data = createSubscriptionSchema.parse(input);
    const application = await scopedRepo(this.prisma.application, entityId).findFirst({
      where: { id: data.applicationId },
    });
    if (!application)
      throw new ValidationError([{ path: 'applicationId', message: 'unknown application' }]);
    if (application.status !== 'active') {
      throw new ConflictError('Only active applications can request access');
    }
    const version = await this.prisma.apiVersion.findUnique({
      where: { id: data.apiVersionId },
      include: { api: true, allowedPurposes: true },
    });
    // Drafts and versions under review do not exist for consumers.
    if (!version || version.status !== 'published') throw new NotFoundError('API version');

    const errors: FieldError[] = [];
    if (!version.allowedPurposes.some((p) => p.purposeCode === data.purposeCode)) {
      errors.push({ path: 'purposeCode', message: 'this API version does not allow that purpose' });
    }
    const known = new Set(operationsOf(version.openapiSpec).map((o) => o.operationId));
    const unknown = data.requestedOperations.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      errors.push({
        path: 'requestedOperations',
        message: `unknown operations: ${unknown.join(', ')}`,
      });
    }
    if (
      data.requestedOperations.length === 0 &&
      readOnlyOperations(version.openapiSpec).length === 0
    ) {
      errors.push({
        path: 'requestedOperations',
        message: 'this version has no read-only operations; choose the operations you need',
      });
    }
    const max = maxValidityMonths(version.api.classification);
    if (data.validityMonths > max) {
      errors.push({
        path: 'validityMonths',
        message: `at most ${max} months for this classification`,
      });
    }
    if (errors.length > 0) throw new ValidationError(errors);

    const now = new Date();
    const actor = { type: 'user' as const, id: principal.keycloakSub, entityId };
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const created = await tx.subscription.create({
          data: {
            applicationId: application.id,
            apiVersionId: version.id,
            purposeCode: data.purposeCode,
            purposeDetail: data.purposeDetail,
            legalBasisText: data.legalBasisText,
            legalReference: data.legalReference ?? null,
            requestedOperations: data.requestedOperations,
            approvedOperations: [],
            requestedValidityMonths: data.validityMonths,
            requestedRateLimit: data.requestedRateLimit ?? null,
            validFrom: now,
            validUntil: addMonths(now, data.validityMonths),
            status: 'pending_provider',
            endUserIdentificationRequired: endUserRequired(version.api.classification),
            requestedBy: principal.userId,
            createdBy: principal.keycloakSub,
          },
        });
        await this.audit.record(tx, {
          actor,
          action: 'subscription.requested',
          target: { type: 'subscription', id: created.id },
          after: created,
          requestId,
        });
        return created.id;
      });
      return this.getForConsumer(entityId, id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(
          'This application already has a live request for this API version and purpose',
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Provider side: /entities/:entityId/access-requests (the entity owns the API)
  // -------------------------------------------------------------------------------------------

  listForProvider(entityId: string, query: SubscriptionListQuery) {
    return this.page({ apiVersion: { api: { entityId } } }, query);
  }

  private async loadForProvider(entityId: string, subscriptionId: string): Promise<Row> {
    const row = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, apiVersion: { api: { entityId } } },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Access request');
    return row;
  }

  async getForProvider(entityId: string, subscriptionId: string): Promise<SubscriptionDetail> {
    return this.detail(await this.loadForProvider(entityId, subscriptionId));
  }

  /**
   * Separation of duties (SPEC.md §2.2, §4.4): whoever asked for access, or created the
   * application asking, cannot decide on it, even with the data steward role in another entity.
   */
  private assertNotRequester(principal: Principal, s: Row): void {
    if (s.requestedBy === principal.userId || s.application.createdBy === principal.userId) {
      throw new ForbiddenError(
        'You cannot decide on an access request you or your application made',
      );
    }
  }

  /** Moves the request only if it is still where we read it and the decider is not the requester. */
  private async move(
    tx: Tx,
    s: Row,
    to: SubscriptionStatus,
    principal: Principal,
    data: Prisma.SubscriptionUpdateManyMutationInput = {},
  ) {
    assertTransition(s.status, to);
    const changed = await tx.subscription.updateMany({
      where: {
        id: s.id,
        status: s.status,
        requestedBy: { not: principal.userId },
        application: { createdBy: { not: principal.userId } },
      },
      data: { status: to, ...data },
    });
    if (changed.count === 0) throw new ConflictError('The request changed meanwhile; reload it');
  }

  async approve(
    entityId: string,
    subscriptionId: string,
    principal: Principal,
    input: ApproveSubscriptionInput,
    requestId?: string,
  ): Promise<SubscriptionDetail> {
    const data = approveSubscriptionSchema.parse(input);
    const before = await this.loadForProvider(entityId, subscriptionId);
    const { api } = before.apiVersion;
    const next: SubscriptionStatus = requiresRegulator(
      api.classification,
      before.apiVersion.exposedFields,
    )
      ? 'pending_regulator'
      : 'approved';
    assertProviderStep(before.status, next);
    this.assertNotRequester(principal, before);

    // The approval may only narrow the request.
    const requested = this.effectiveRequested(before);
    const operations = data.approvedOperations ?? requested;
    const errors: FieldError[] = [];
    const extra = operations.filter((id) => !requested.includes(id));
    if (extra.length > 0) {
      errors.push({ path: 'approvedOperations', message: `not requested: ${extra.join(', ')}` });
    }
    const months = data.validityMonths ?? before.requestedValidityMonths;
    if (months > before.requestedValidityMonths) {
      errors.push({
        path: 'validityMonths',
        message: `at most the ${before.requestedValidityMonths} months requested`,
      });
    }
    const ceiling = before.requestedRateLimit ?? before.apiVersion.defaultRateLimit;
    const rateLimit = data.rateLimitPerMinute ?? before.requestedRateLimit;
    if (rateLimit !== null && rateLimit > ceiling) {
      errors.push({
        path: 'rateLimitPerMinute',
        message: `at most ${ceiling} requests per minute`,
      });
    }
    if (errors.length > 0) throw new ValidationError(errors);

    // Validity counts from the decision, not from the request.
    const now = new Date();
    const changes = {
      approvedOperations: operations,
      validFrom: now,
      validUntil: addMonths(now, months),
      rateLimitPerMinute: rateLimit,
    };
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, before, next, principal, changes);
      await tx.subscriptionDecision.create({
        data: {
          subscriptionId,
          decision: 'approved',
          decidedBy: principal.userId,
          decidedByEntityId: entityId,
          comment: data.comment ?? null,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub, entityId },
        action: 'subscription.approved',
        target: { type: 'subscription', id: subscriptionId },
        before: snapshot(before),
        after: { ...snapshot({ ...changes, status: next }), comment: data.comment ?? null },
        requestId,
      });
      if (next === 'approved') {
        // The OPA bundle is rebuilt from the database; M1-09 marks the subscription active once
        // OPA has downloaded the revision that contains it (ARCHITECTURE.md §4).
        await this.outbox.enqueue(tx, {
          topic: POLICY_SYNC_TOPIC,
          aggregate: `subscription:${subscriptionId}`,
          payload: { reason: 'approved' },
        });
      }
    });
    return this.getForProvider(entityId, subscriptionId);
  }

  async reject(
    entityId: string,
    subscriptionId: string,
    principal: Principal,
    input: RejectSubscriptionInput,
    requestId?: string,
  ): Promise<SubscriptionDetail> {
    const { comment } = rejectSubscriptionSchema.parse(input);
    const before = await this.loadForProvider(entityId, subscriptionId);
    assertProviderStep(before.status, 'rejected');
    this.assertNotRequester(principal, before);

    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, before, 'rejected', principal);
      await tx.subscriptionDecision.create({
        data: {
          subscriptionId,
          decision: 'rejected',
          decidedBy: principal.userId,
          decidedByEntityId: entityId,
          comment,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub, entityId },
        action: 'subscription.rejected',
        target: { type: 'subscription', id: subscriptionId },
        before: snapshot(before),
        after: { status: 'rejected', comment },
        requestId,
      });
    });
    return this.getForProvider(entityId, subscriptionId);
  }

  /**
   * Revocation by the provider's data steward (SPEC.md §4.4, M1-10). Final. Unlike approving, it
   * is not subject to separation of duties: it only takes access away, and a steward must be able
   * to cut access that their own application has. The next OPA bundle no longer carries the
   * subscription, so the gateway denies with no_subscription within one polling cycle (< 60 s).
   */
  async revoke(
    entityId: string,
    subscriptionId: string,
    principal: Principal,
    input: RevokeSubscriptionInput,
    requestId?: string,
  ): Promise<SubscriptionDetail> {
    const { comment } = revokeSubscriptionSchema.parse(input);
    const before = await this.loadForProvider(entityId, subscriptionId);
    assertTransition(before.status, 'revoked');

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.subscription.updateMany({
        where: { id: subscriptionId, status: before.status },
        data: { status: 'revoked' },
      });
      if (changed.count === 0)
        throw new ConflictError('The subscription changed meanwhile; reload it');
      await tx.subscriptionDecision.create({
        data: {
          subscriptionId,
          decision: 'revoked',
          decidedBy: principal.userId,
          decidedByEntityId: entityId,
          comment,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub, entityId },
        action: 'subscription.revoked',
        target: { type: 'subscription', id: subscriptionId },
        before: snapshot(before),
        after: { status: 'revoked', comment },
        requestId,
      });
      await this.outbox.enqueue(tx, {
        topic: POLICY_SYNC_TOPIC,
        aggregate: `subscription:${subscriptionId}`,
        payload: { reason: 'revoked' },
      });
    });
    return this.getForProvider(entityId, subscriptionId);
  }
}
