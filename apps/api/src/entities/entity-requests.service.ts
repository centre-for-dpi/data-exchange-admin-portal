import { Injectable } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import {
  DESIGNEE_ENTITY_ROLES,
  DESIGNEE_ROLES,
  type EntityRequest,
  type EntityRequestList,
  type EntityRole,
  type EntityStatus,
  entityRequestInputSchema,
  type PlatformRole,
} from '@rid/contracts';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { PLATFORM_PERMISSIONS } from '../auth/policy.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors.js';
import { DocumentsService } from '../documents/documents.service.js';
import { assertTransition, OPEN_REQUEST_STATUSES } from '../domain/entity/state-machine.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { InvitationsService } from './invitations.service.js';

type RequestInput = z.output<typeof entityRequestInputSchema>;

/** Open requests one person may have at a time (ADR-0018: accounts are self-registered). */
export const MAX_OPEN_REQUESTS = 3;

const INCLUDE = {
  designees: { orderBy: { role: 'asc' } },
  designationDocument: true,
  reviews: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.EntityInclude;

type Loaded = Prisma.EntityGetPayload<{ include: typeof INCLUDE }>;

const REVIEWER_ROLE_PREFERENCE: readonly PlatformRole[] = ['platform_reviewer', 'platform_admin'];

const userActor = (principal: Principal) => ({ type: 'user' as const, id: principal.keycloakSub });

/** Fields of the entity recorded in audit events (no document bytes, no secrets). */
const snapshot = (e: Loaded) => ({
  status: e.status,
  slug: e.slug,
  legalName: e.legalName,
  shortName: e.shortName,
  taxIdType: e.taxIdType,
  taxId: e.taxId,
  kind: e.kind,
  sector: e.sector,
  contactEmail: e.contactEmail,
  website: e.website,
  dpoName: e.dpoName,
  dpoEmail: e.dpoEmail,
  designees: e.designees.map((d) => ({ role: d.role, fullName: d.fullName, email: d.email })),
  designationDocument: e.designationDocument
    ? { id: e.designationDocument.id, sha256: e.designationDocument.sha256 }
    : null,
});

/**
 * Onboarding of entities (SPEC.md §4.1, M2-01). Any signed-in person may ask for an entity to join
 * (ADR-0018); the request is an Entity row in `requested`. The applicant fills it in, attaches
 * the designation document and submits it; the operator approves, asks for corrections or
 * rejects. On approval the applicant becomes entity_admin and each designee is invited by e-mail.
 */
@Injectable()
export class EntityRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    private readonly invitations: InvitationsService,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------------------------------

  private canReview(principal: Principal): boolean {
    const allowed: readonly string[] = PLATFORM_PERMISSIONS['entity_review.read'];
    return principal.platformRoles.some((r) => allowed.includes(r));
  }

  /**
   * The request, for its applicant or for the operator. Anyone else gets 404, as for any resource
   * outside their reach. Entities created by the seed (no applicant) are not requests.
   */
  private async load(requestId: string, principal: Principal): Promise<Loaded> {
    const entity = await this.prisma.entity.findUnique({
      where: { id: requestId },
      include: INCLUDE,
    });
    if (!entity?.applicantId) throw new NotFoundError('Entity request');
    if (entity.applicantId !== principal.userId && !this.canReview(principal)) {
      throw new NotFoundError('Entity request');
    }
    return entity;
  }

  private async view(entity: Loaded): Promise<EntityRequest> {
    const applicant = entity.applicantId
      ? await this.prisma.user.findUnique({
          where: { id: entity.applicantId },
          select: { id: true, fullName: true, email: true },
        })
      : null;
    const doc = entity.designationDocument;
    return {
      id: entity.id,
      status: entity.status,
      slug: entity.slug,
      legalName: entity.legalName,
      shortName: entity.shortName,
      taxIdType: entity.taxIdType,
      taxId: entity.taxId,
      kind: entity.kind,
      sector: entity.sector,
      contactEmail: entity.contactEmail,
      website: entity.website,
      dpoName: entity.dpoName,
      dpoEmail: entity.dpoEmail,
      designees: entity.designees.map((d) => ({
        role: d.role,
        fullName: d.fullName,
        email: d.email,
      })),
      designationDocument: doc
        ? {
            id: doc.id,
            fileName: doc.fileName,
            mimeType: doc.mimeType,
            size: doc.size,
            sha256: doc.sha256,
            uploadedAt: doc.createdAt.toISOString(),
          }
        : null,
      applicant,
      submittedAt: entity.submittedAt?.toISOString() ?? null,
      decidedAt: entity.decidedAt?.toISOString() ?? null,
      createdAt: entity.createdAt.toISOString(),
      reviews: entity.reviews.map((r) => ({
        decision: r.decision,
        reviewerRole: r.reviewerRole,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async get(requestId: string, principal: Principal): Promise<EntityRequest> {
    return this.view(await this.load(requestId, principal));
  }

  private static item(e: {
    id: string;
    status: EntityStatus;
    slug: string;
    shortName: string;
    legalName: string;
    submittedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: e.id,
      status: e.status,
      slug: e.slug,
      shortName: e.shortName,
      legalName: e.legalName,
      submittedAt: e.submittedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    };
  }

  /** The caller's own requests, newest first. */
  async mine(principal: Principal): Promise<EntityRequestList> {
    const rows = await this.prisma.entity.findMany({
      where: { applicantId: principal.userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { items: rows.map((row) => EntityRequestsService.item(row)) };
  }

  /** Operator queue: requests in one status, oldest submission first. */
  async queue(status: EntityStatus): Promise<EntityRequestList> {
    const rows = await this.prisma.entity.findMany({
      where: { status, applicantId: { not: null } },
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return { items: rows.map((row) => EntityRequestsService.item(row)) };
  }

  /** The designation document, for the applicant and the operator. */
  async designationDocument(requestId: string, principal: Principal) {
    const entity = await this.load(requestId, principal);
    if (!entity.designationDocumentId) throw new NotFoundError('Designation document');
    return this.documents.read(entity.designationDocumentId);
  }

  // ------------------------------------------------------------------------------------------
  // Applicant
  // ------------------------------------------------------------------------------------------

  /** Values from the country config (rule 6): organization identifier types and sectors. */
  private static checkAgainstConfig(input: RequestInput): void {
    const config = getCountryConfig();
    const errors: Array<{ path: string; message: string }> = [];
    if (!config.identifiers.organization.includes(input.taxIdType)) {
      errors.push({ path: 'taxIdType', message: `Unknown identifier type "${input.taxIdType}"` });
    }
    if (!config.sectors.some((s) => s.code === input.sector)) {
      errors.push({ path: 'sector', message: `Unknown sector "${input.sector}"` });
    }
    if (errors.length > 0) throw new ValidationError(errors);
  }

  /** Statuses that hold the slug and tax id (see the partial unique indexes on `entity`). */
  private static readonly CLAIMING: EntityStatus[] = [
    'under_review',
    'active',
    'suspended',
    'offboarded',
  ];

  /**
   * Field errors when a submitted or existing entity already holds the slug or tax id. Drafts
   * never block each other; the indexes settle races when a draft is submitted.
   */
  private async assertUnclaimed(input: RequestInput, exceptId?: string): Promise<void> {
    const taken = await this.prisma.entity.findMany({
      where: {
        status: { in: EntityRequestsService.CLAIMING },
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [{ slug: input.slug }, { taxIdType: input.taxIdType, taxId: input.taxId }],
      },
      select: { slug: true, taxIdType: true, taxId: true },
    });
    const errors: Array<{ path: string; message: string }> = [];
    if (taken.some((e) => e.slug === input.slug)) {
      errors.push({ path: 'slug', message: 'Another entity already uses this identifier' });
    }
    if (taken.some((e) => e.taxIdType === input.taxIdType && e.taxId === input.taxId)) {
      errors.push({ path: 'taxId', message: 'Another entity already uses this tax id' });
    }
    if (errors.length > 0) throw new ValidationError(errors);
  }

  /** Turns a unique-index violation (slug or tax id already taken) into a field error. */
  private static async uniquely<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const detail = JSON.stringify(error.meta ?? {});
        const path = detail.includes('tax_id') ? 'taxId' : 'slug';
        throw new ValidationError([
          {
            path,
            message:
              path === 'slug'
                ? 'Another entity already uses this identifier'
                : 'Another entity already uses this tax id',
          },
        ]);
      }
      throw error;
    }
  }

  private static entityData(input: RequestInput) {
    return {
      legalName: input.legalName,
      shortName: input.shortName,
      slug: input.slug,
      taxIdType: input.taxIdType,
      taxId: input.taxId,
      kind: input.kind,
      sector: input.sector,
      contactEmail: input.contactEmail,
      website: input.website ?? null,
      dpoName: input.dpoName,
      dpoEmail: input.dpoEmail,
    };
  }

  private static designees(input: RequestInput) {
    return DESIGNEE_ROLES.map((role) => ({
      role,
      fullName: input.designees[role].fullName,
      email: input.designees[role].email,
    }));
  }

  async create(
    input: RequestInput,
    principal: Principal,
    requestId?: string,
  ): Promise<EntityRequest> {
    EntityRequestsService.checkAgainstConfig(input);
    if (!principal.emailVerified) {
      throw new ForbiddenError('Verify your e-mail address before requesting an onboarding');
    }
    await this.assertUnclaimed(input);
    const open = await this.prisma.entity.count({
      where: { applicantId: principal.userId, status: { in: [...OPEN_REQUEST_STATUSES] } },
    });
    if (open >= MAX_OPEN_REQUESTS) {
      throw new ConflictError(
        `You already have ${MAX_OPEN_REQUESTS} open requests; wait for a decision first`,
      );
    }
    const id = await EntityRequestsService.uniquely(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.entity.create({
          data: {
            ...EntityRequestsService.entityData(input),
            status: 'requested',
            applicantId: principal.userId,
            createdBy: principal.userId,
            designees: { create: EntityRequestsService.designees(input) },
          },
          include: INCLUDE,
        });
        await this.audit.record(tx, {
          actor: userActor(principal),
          action: 'entity.requested',
          target: { type: 'entity', id: created.id },
          after: snapshot(created),
          requestId,
        });
        return created.id;
      }),
    );
    return this.get(id, principal);
  }

  /** Only the applicant edits, and only while it is their turn (`requested`). */
  private async loadForApplicant(requestId: string, principal: Principal): Promise<Loaded> {
    const entity = await this.load(requestId, principal);
    if (entity.applicantId !== principal.userId) {
      throw new ForbiddenError('Only the applicant can change the request');
    }
    if (entity.status !== 'requested') {
      throw new ConflictError('The request can only be changed while it is with the applicant');
    }
    return entity;
  }

  /** Optimistic guard: the row is still `requested` (no concurrent submit or decision). */
  private static async stillRequested(tx: Tx, id: string): Promise<void> {
    const changed = await tx.entity.updateMany({
      where: { id, status: 'requested' },
      data: { updatedAt: new Date() },
    });
    if (changed.count === 0) throw new ConflictError('The request changed meanwhile; reload it');
  }

  async update(
    requestId: string,
    input: RequestInput,
    principal: Principal,
    requestIdHeader?: string,
  ): Promise<EntityRequest> {
    const before = await this.loadForApplicant(requestId, principal);
    EntityRequestsService.checkAgainstConfig(input);
    await this.assertUnclaimed(input, requestId);
    await EntityRequestsService.uniquely(() =>
      this.prisma.$transaction(async (tx) => {
        await EntityRequestsService.stillRequested(tx, requestId);
        await tx.entity.update({
          where: { id: requestId },
          data: EntityRequestsService.entityData(input),
        });
        for (const designee of EntityRequestsService.designees(input)) {
          await tx.entityDesignee.upsert({
            where: { entityId_role: { entityId: requestId, role: designee.role } },
            create: { entityId: requestId, ...designee },
            update: { fullName: designee.fullName, email: designee.email },
          });
        }
        const after = await tx.entity.findUniqueOrThrow({
          where: { id: requestId },
          include: INCLUDE,
        });
        await this.audit.record(tx, {
          actor: userActor(principal),
          action: 'entity.request_updated',
          target: { type: 'entity', id: requestId },
          before: snapshot(before),
          after: snapshot(after),
          requestId: requestIdHeader,
        });
      }),
    );
    return this.get(requestId, principal);
  }

  /** Attaches (or replaces) the designation document while the request is with the applicant. */
  async attachDesignation(
    requestId: string,
    file: { fileName: string; bytes: Buffer },
    principal: Principal,
    requestIdHeader?: string,
  ): Promise<EntityRequest> {
    const before = await this.loadForApplicant(requestId, principal);
    await this.prisma.$transaction(async (tx) => {
      await EntityRequestsService.stillRequested(tx, requestId);
      const document = await this.documents.storePdf(tx, {
        ownerEntityId: requestId,
        kind: 'designation',
        fileName: file.fileName,
        bytes: file.bytes,
        createdBy: principal.userId,
      });
      await tx.entity.update({
        where: { id: requestId },
        data: { designationDocumentId: document.id },
      });
      await this.audit.record(tx, {
        actor: userActor(principal),
        action: 'document.uploaded',
        target: { type: 'document', id: document.id },
        after: {
          entityId: requestId,
          kind: 'designation',
          fileName: document.fileName,
          size: document.size,
          sha256: document.sha256,
          replaces: before.designationDocumentId,
        },
        requestId: requestIdHeader,
      });
    });
    return this.get(requestId, principal);
  }

  async submit(requestId: string, principal: Principal, requestIdHeader?: string) {
    const before = await this.loadForApplicant(requestId, principal);
    assertTransition(before.status, 'under_review');
    if (!before.designationDocumentId) {
      throw new ValidationError([
        { path: 'designationDocument', message: 'Attach the designation document first' },
      ]);
    }
    // Submitting claims the slug and tax id: if another request got there first, the partial
    // unique index rejects it and the applicant sees which field to change.
    await EntityRequestsService.uniquely(() =>
      this.prisma.$transaction(async (tx) => {
        const changed = await tx.entity.updateMany({
          where: { id: requestId, status: 'requested' },
          data: { status: 'under_review', submittedAt: new Date() },
        });
        if (changed.count === 0)
          throw new ConflictError('The request changed meanwhile; reload it');
        await this.audit.record(tx, {
          actor: userActor(principal),
          action: 'entity.submitted',
          target: { type: 'entity', id: requestId },
          before: { status: before.status },
          after: { status: 'under_review' },
          requestId: requestIdHeader,
        });
      }),
    );
    return this.get(requestId, principal);
  }

  // ------------------------------------------------------------------------------------------
  // Operator
  // ------------------------------------------------------------------------------------------

  private reviewerRole(principal: Principal): PlatformRole {
    const allowed: readonly string[] = PLATFORM_PERMISSIONS['entity_review.decide'];
    const role = REVIEWER_ROLE_PREFERENCE.find(
      (r) => principal.platformRoles.includes(r) && allowed.includes(r),
    );
    if (!role) throw new ForbiddenError();
    return role;
  }

  /**
   * Separation of duties: nobody decides on a request they filed or in which they are designated.
   */
  private static assertImpartial(principal: Principal, entity: Loaded): void {
    if (entity.applicantId === principal.userId) {
      throw new ForbiddenError('You cannot review a request you filed');
    }
    const email = principal.email.toLowerCase();
    if (entity.designees.some((d) => d.email === email)) {
      throw new ForbiddenError('You cannot review a request that designates you');
    }
  }

  private async decide(
    requestId: string,
    principal: Principal,
    decision: 'approved' | 'changes_requested' | 'rejected',
    comment: string | undefined,
    requestIdHeader: string | undefined,
  ): Promise<EntityRequest> {
    const before = await this.load(requestId, principal);
    const role = this.reviewerRole(principal);
    const to: EntityStatus =
      decision === 'approved' ? 'active' : decision === 'rejected' ? 'rejected' : 'requested';
    assertTransition(before.status, to);
    EntityRequestsService.assertImpartial(principal, before);
    const actor = userActor(principal);

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.entity.updateMany({
        where: { id: requestId, status: 'under_review', applicantId: { not: principal.userId } },
        data: { status: to, ...(to === 'requested' ? {} : { decidedAt: new Date() }) },
      });
      if (changed.count === 0) throw new ConflictError('The request changed meanwhile; reload it');
      await tx.entityReview.create({
        data: {
          entityId: requestId,
          decision,
          reviewerRole: role,
          reviewerId: principal.userId,
          comment: comment ?? null,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: `entity.${decision}`,
        target: { type: 'entity', id: requestId },
        before: { status: before.status },
        after: { status: to, reviewerRole: role, comment: comment ?? null },
        requestId: requestIdHeader,
      });
      if (decision === 'approved') await this.grantAccess(tx, before, principal, requestIdHeader);
    });
    return this.get(requestId, principal);
  }

  /**
   * On approval (SPEC.md §4.1 step 3): the applicant becomes entity_admin (plus the roles of any
   * responsibility designated to their own address), and every other designee is invited.
   * Two responsibilities on one address make one invitation with both sets of roles.
   */
  private async grantAccess(
    tx: Tx,
    entity: Loaded,
    principal: Principal,
    requestId: string | undefined,
  ): Promise<void> {
    const applicantId = entity.applicantId;
    if (!applicantId) return;
    const applicant = await tx.user.findUniqueOrThrow({ where: { id: applicantId } });
    const applicantEmail = applicant.email.toLowerCase();

    const byEmail = new Map<string, { fullName: string; roles: Set<EntityRole> }>();
    for (const d of entity.designees) {
      const entry = byEmail.get(d.email) ?? { fullName: d.fullName, roles: new Set<EntityRole>() };
      for (const r of DESIGNEE_ENTITY_ROLES[d.role]) entry.roles.add(r);
      byEmail.set(d.email, entry);
    }

    const adminRoles = new Set<EntityRole>([
      'entity_admin',
      ...(byEmail.get(applicantEmail)?.roles ?? []),
    ]);
    byEmail.delete(applicantEmail);
    const membership = await tx.membership.create({
      data: {
        userId: applicantId,
        entityId: entity.id,
        roles: [...adminRoles],
        status: 'active',
        invitedBy: principal.userId,
        createdBy: principal.userId,
      },
    });
    await this.audit.record(tx, {
      actor: { type: 'system', id: 'system:entity-onboarding' },
      action: 'membership.created',
      target: { type: 'membership', id: membership.id },
      after: {
        userId: applicantId,
        entityId: entity.id,
        roles: membership.roles,
        status: 'active',
      },
      requestId,
    });

    for (const [email, designee] of byEmail) {
      await this.invitations.createInTx(tx, {
        entityId: entity.id,
        email,
        fullName: designee.fullName,
        roles: [...designee.roles],
        invitedBy: principal.userId,
        createdBy: 'system:entity-onboarding',
        actor: { type: 'system', id: 'system:entity-onboarding' },
        requestId,
      });
    }
  }

  approve(requestId: string, principal: Principal, comment?: string, requestIdHeader?: string) {
    return this.decide(requestId, principal, 'approved', comment, requestIdHeader);
  }

  requestChanges(
    requestId: string,
    principal: Principal,
    comment: string,
    requestIdHeader?: string,
  ) {
    return this.decide(requestId, principal, 'changes_requested', comment, requestIdHeader);
  }

  reject(requestId: string, principal: Principal, comment: string, requestIdHeader?: string) {
    return this.decide(requestId, principal, 'rejected', comment, requestIdHeader);
  }
}
