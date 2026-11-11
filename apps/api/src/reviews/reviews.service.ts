import { Injectable } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import type { ApiVersionStatus, PlatformRole, ReviewDetail } from '@rid/contracts';
import { ApisService, VERSION_INCLUDE, versionSnapshot } from '../apis/apis.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PLATFORM_PERMISSIONS } from '../auth/policy.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors.js';
import { assertTransition } from '../domain/api-version/state-machine.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';

/** Outbox topic consumed by the APISIX reconciler (M1-08). */
export const GATEWAY_SYNC_TOPIC = 'gateway.sync';

const REVIEWER_ROLE_PREFERENCE: readonly PlatformRole[] = ['platform_reviewer', 'platform_admin'];

/**
 * Operator review of API versions (SPEC.md §4.2, M1-04). Approving publishes the version unless
 * the regulator must also approve it (sensitive data, features.approval.regulatorForSensitive,
 * M2-04). Publishing enqueues the gateway reconciliation; it never calls APISIX directly.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly apis: ApisService,
  ) {}

  async queue(status: ApiVersionStatus) {
    const rows = await this.prisma.apiVersion.findMany({
      where: { status },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: 200,
      include: { api: { include: { entity: true } } },
    });
    return {
      items: rows.map((v) => ({
        versionId: v.id,
        version: v.version,
        status: v.status,
        submittedAt: v.submittedAt?.toISOString() ?? null,
        api: { id: v.api.id, name: v.api.name, classification: v.api.classification },
        entity: { id: v.api.entity.id, slug: v.api.entity.slug, shortName: v.api.entity.shortName },
      })),
    };
  }

  private async load(versionId: string) {
    const version = await this.prisma.apiVersion.findUnique({
      where: { id: versionId },
      include: { ...VERSION_INCLUDE, api: { include: { entity: true } } },
    });
    if (!version) throw new NotFoundError('API version');
    return version;
  }

  private requiresRegulator(classification: string): boolean {
    return (
      classification === 'sensitive' && getCountryConfig().features.approval.regulatorForSensitive
    );
  }

  async detail(versionId: string): Promise<ReviewDetail> {
    const v = await this.load(versionId);
    const { api } = v;
    return {
      entity: {
        id: api.entity.id,
        slug: api.entity.slug,
        shortName: api.entity.shortName,
        legalName: api.entity.legalName,
      },
      api: {
        id: api.id,
        name: api.name,
        summary: api.summary,
        description: api.description,
        sector: api.sector,
        classification: api.classification,
        ownerContact: api.ownerContact,
      },
      version: this.apis.toVersionDetail(v),
      requiresRegulator: this.requiresRegulator(api.classification),
    };
  }

  private reviewerRole(principal: Principal): PlatformRole {
    const allowed: readonly string[] = PLATFORM_PERMISSIONS['review.decide'];
    const role = REVIEWER_ROLE_PREFERENCE.find(
      (r) => principal.platformRoles.includes(r) && allowed.includes(r),
    );
    if (!role) throw new ForbiddenError();
    return role;
  }

  /** Moves the version from `from` to `to` only if nobody changed it meanwhile. */
  private async move(tx: Tx, id: string, from: ApiVersionStatus, to: ApiVersionStatus, data = {}) {
    assertTransition(from, to);
    const changed = await tx.apiVersion.updateMany({
      where: { id, status: from },
      data: { status: to, ...data },
    });
    if (changed.count === 0) throw new ConflictError('The version changed meanwhile; reload it');
  }

  async approve(versionId: string, principal: Principal, comment?: string, requestId?: string) {
    const before = await this.load(versionId);
    const role = this.reviewerRole(principal);
    assertTransition(before.status, 'approved_operator');
    // Separation of duties (SPEC.md §2.2): nobody approves what they submitted.
    if (before.submittedBy === principal.userId) {
      throw new ForbiddenError('You cannot approve a version you submitted');
    }
    const actor = { type: 'user' as const, id: principal.keycloakSub };
    const publish = !this.requiresRegulator(before.api.classification);

    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, versionId, 'in_review', 'approved_operator');
      await tx.apiVersionReview.create({
        data: {
          apiVersionId: versionId,
          decision: 'approved',
          reviewerRole: role,
          reviewerId: principal.userId,
          comment: comment ?? null,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'api_version.approved',
        target: { type: 'api_version', id: versionId },
        before: versionSnapshot(before),
        after: { status: 'approved_operator', reviewerRole: role, comment: comment ?? null },
        requestId,
      });

      if (publish) {
        await this.move(tx, versionId, 'approved_operator', 'published', {
          publishedAt: new Date(),
        });
        if (before.api.status !== 'published') {
          await tx.api.update({ where: { id: before.apiId }, data: { status: 'published' } });
        }
        // The gateway route is created by the reconciler from the database state (ADR-0007).
        await this.outbox.enqueue(tx, {
          topic: GATEWAY_SYNC_TOPIC,
          aggregate: `apiVersion:${versionId}`,
          payload: { reason: 'published' },
        });
        await this.audit.record(tx, {
          actor,
          action: 'api_version.published',
          target: { type: 'api_version', id: versionId },
          after: { status: 'published', basePath: before.basePath },
          requestId,
        });
      }
    });
    return this.detail(versionId);
  }

  async requestChanges(
    versionId: string,
    principal: Principal,
    comment: string,
    requestId?: string,
  ) {
    const before = await this.load(versionId);
    const role = this.reviewerRole(principal);
    assertTransition(before.status, 'changes_requested');

    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, versionId, 'in_review', 'changes_requested');
      await tx.apiVersionReview.create({
        data: {
          apiVersionId: versionId,
          decision: 'changes_requested',
          reviewerRole: role,
          reviewerId: principal.userId,
          comment,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub },
        action: 'api_version.changes_requested',
        target: { type: 'api_version', id: versionId },
        before: versionSnapshot(before),
        after: { status: 'changes_requested', reviewerRole: role, comment },
        requestId,
      });
    });
    return this.detail(versionId);
  }
}
