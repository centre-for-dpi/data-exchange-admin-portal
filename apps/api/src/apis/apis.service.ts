import { FieldErrorKey } from '@den/contracts';
import { Injectable } from '@nestjs/common';
import { getCountryConfig } from '@den/config';
import type {
  ApiDetail,
  ApiSummary,
  ApiVersionDetail,
  UpstreamNode,
  ApiVersionStatus,
  CreateApiInput,
  CreateApiVersionInput,
  HostProof,
  LintReport,
  UpdateApiVersionInput,
  NodeContract,
  PaginationQuery,
} from '@den/contracts';
import {
  createApiSchema,
  createApiVersionSchema,
  type Upstream,
  updateApiVersionSchema,
  upstreamSchema,
} from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../common/errors.js';
import { breakingChanges } from '../domain/api-version/compatibility.js';
import { assertClassificationCoversFields } from '../domain/approval.js';
import { assertEntityActive } from '../domain/entity/active.js';
import { assertTransition, isEditable } from '../domain/api-version/state-machine.js';
import { Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { HOST_CONTROL_PATH, hostControlToken } from '../reconcilers/apisix/desired-state.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';
import { nodeContracts } from '../nodes/node-contracts.js';
import { nodeIdOf, upstreamNodes } from '../nodes/node-status.js';
import { scopedRepo } from '../prisma/scoped-repo.js';
import {
  storedValidation,
  validationEnabled,
  validationSettings,
  VersionValidationService,
} from './version-validation.service.js';
import { lintOpenApi, listOperations } from './lint/openapi-lint.js';
import { assertUpstreamTypeAllowed, disallowedUpstreamTypes } from './upstream-types.js';

type ApiRow = Prisma.ApiGetPayload<object>;
export const VERSION_INCLUDE = {
  allowedPurposes: true,
  reviews: { orderBy: { createdAt: 'asc' } },
  revisions: {
    orderBy: { createdAt: 'asc' },
    select: { version: true, openapiSha256: true, createdAt: true },
  },
} as const satisfies Prisma.ApiVersionInclude;
export type VersionRow = Prisma.ApiVersionGetPayload<{ include: typeof VERSION_INCLUDE }>;

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

const toSummary = (api: ApiRow): ApiSummary => ({
  id: api.id,
  entityId: api.entityId,
  slug: api.slug,
  name: api.name,
  summary: api.summary,
  sector: api.sector,
  classification: api.classification,
  status: api.status,
  updatedAt: api.updatedAt.toISOString(),
});

/** Audit snapshot of a version: domain fields only, not the (large) OpenAPI document. */
export const versionSnapshot = (v: VersionRow) => ({
  id: v.id,
  apiId: v.apiId,
  version: v.version,
  status: v.status,
  basePath: v.basePath,
  upstream: v.upstream,
  exposedFields: v.exposedFields,
  allowedPurposes: v.allowedPurposes.map((p) => p.purposeCode),
  openapiSha256: v.openapiSha256,
  lintValid: (v.lintReport as LintReport | null)?.valid ?? false,
});

/** The stored upstreams of a version still have types the deployment accepts (P-04). */
function assertStoredUpstreamsAllowed(v: VersionRow): void {
  assertUpstreamTypeAllowed(v.upstreamType, 'upstream');
  const sandbox = v.sandboxUpstream as { type?: Upstream['type'] } | null;
  if (sandbox?.type) assertUpstreamTypeAllowed(sandbox.type, 'sandboxUpstream');
}

/**
 * Registration of APIs and versions by the provider entity (SPEC.md §4.2, M1-03). Every state
 * change is audited in the same transaction (CLAUDE.md, rule 4). Nothing here talks to APISIX:
 * publication (M1-04) enqueues the reconciliation.
 */
@Injectable()
export class ApisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly validation: VersionValidationService,
  ) {}

  private actor(principal: Principal, entityId: string) {
    return { type: 'user' as const, id: principal.keycloakSub, entityId };
  }

  async list(entityId: string, page: PaginationQuery) {
    const rows = await scopedRepo(this.prisma.api, entityId).findMany({
      orderBy: { id: 'asc' },
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, page.limit);
    return {
      items: items.map(toSummary),
      nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  private async findApi(entityId: string, apiId: string): Promise<ApiRow> {
    const api = await scopedRepo(this.prisma.api, entityId).findFirst({ where: { id: apiId } });
    if (!api) throw new NotFoundError('API');
    return api;
  }

  async get(entityId: string, apiId: string): Promise<ApiDetail> {
    const api = await this.findApi(entityId, apiId);
    const versions = await this.prisma.apiVersion.findMany({
      where: { apiId: api.id },
      orderBy: [{ major: 'desc' }, { minor: 'desc' }],
    });
    return {
      ...toSummary(api),
      description: api.description,
      tags: api.tags,
      ownerContact: api.ownerContact,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        basePath: v.basePath,
        updatedAt: v.updatedAt.toISOString(),
      })),
    };
  }

  async create(
    entityId: string,
    principal: Principal,
    input: CreateApiInput,
    requestId?: string,
  ): Promise<ApiDetail> {
    await assertEntityActive(this.prisma, entityId);
    const data = createApiSchema.parse(input);
    const sectors = getCountryConfig().sectors.map((s) => s.code);
    if (!sectors.includes(data.sector)) {
      throw new ValidationError([
        {
          path: 'sector',
          message: `Unknown sector "${data.sector}"`,
          key: FieldErrorKey.UnknownSector,
        },
      ]);
    }
    let api: ApiRow;
    try {
      api = await this.prisma.$transaction(async (tx) => {
        const created = await tx.api.create({
          data: { ...data, entityId, status: 'draft', createdBy: principal.userId },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal, entityId),
          action: 'api.created',
          target: { type: 'api', id: created.id },
          after: created,
          requestId,
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`The entity already has an API with slug "${data.slug}"`);
      }
      throw error;
    }
    return this.get(entityId, api.id);
  }

  private async findVersion(
    entityId: string,
    apiId: string,
    versionId: string,
  ): Promise<VersionRow> {
    const api = await this.findApi(entityId, apiId);
    const version = await this.prisma.apiVersion.findFirst({
      where: { id: versionId, apiId: api.id },
      include: VERSION_INCLUDE,
    });
    if (!version) throw new NotFoundError('API version');
    return version;
  }

  /** The detail of a version, with the state of its kit node (M4-04). */
  async detailOf(v: VersionRow & { api?: { entityId: string } }): Promise<ApiVersionDetail> {
    const nodeId = nodeIdOf(v.upstream);
    const entityId =
      v.api?.entityId ??
      (
        await this.prisma.api.findUniqueOrThrow({
          where: { id: v.apiId },
          select: { entityId: true },
        })
      ).entityId;
    const nodes = nodeId
      ? await upstreamNodes(this.prisma, [{ upstream: v.upstream, entityId }])
      : null;
    // P-02: what the node serves against the published contract (served versions only).
    const [contract] = nodeId ? await nodeContracts(this.prisma, { versionIds: [v.id] }) : [];
    const nodeContract: NodeContract | null = contract
      ? {
          status: contract.status,
          servicePath: contract.servicePath,
          serviceName: contract.serviceName,
          expectedSha256: contract.expectedSha256,
          reportedSha256: contract.reportedSha256,
          since: contract.since,
        }
      : null;
    return this.toVersionDetail(v, (nodeId && nodes?.get(nodeId)) || null, nodeContract);
  }

  toVersionDetail(
    v: VersionRow,
    node: UpstreamNode | null = null,
    nodeContract: NodeContract | null = null,
  ): ApiVersionDetail {
    return {
      id: v.id,
      apiId: v.apiId,
      version: v.version,
      status: v.status,
      basePath: v.basePath,
      updatedAt: v.updatedAt.toISOString(),
      upstream: upstreamSchema.parse(v.upstream),
      node,
      sandboxUpstream: v.sandboxUpstream ? upstreamSchema.parse(v.sandboxUpstream) : null,
      disallowedUpstreamTypes: disallowedUpstreamTypes([
        v.upstream as { type?: unknown } | null,
        v.sandboxUpstream as { type?: unknown } | null,
      ]),
      nodeContract,
      validation: storedValidation(v.validationReport),
      exposedFields: v.exposedFields as ApiVersionDetail['exposedFields'],
      allowedPurposes: v.allowedPurposes.map((p) => p.purposeCode).sort(),
      legalBasisText: v.legalBasisText,
      legalReferences: v.legalReferences,
      defaultRateLimit: v.defaultRateLimit,
      openapiSha256: v.openapiSha256,
      lintReport: (v.lintReport as LintReport | null) ?? { valid: false, issues: [] },
      operations: listOperations(v.openapiSpec as Record<string, unknown>),
      submittedAt: v.submittedAt?.toISOString() ?? null,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      deprecatedAt: v.deprecatedAt?.toISOString() ?? null,
      sunsetAt: v.sunsetAt?.toISOString() ?? null,
      retiredAt: v.retiredAt?.toISOString() ?? null,
      revisions: v.revisions.map((r) => ({
        version: r.version,
        openapiSha256: r.openapiSha256,
        replacedAt: r.createdAt.toISOString(),
      })),
      reviews: v.reviews.map((r) => ({
        decision: r.decision,
        reviewerRole: r.reviewerRole,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async getVersion(entityId: string, apiId: string, versionId: string): Promise<ApiVersionDetail> {
    return this.detailOf(await this.findVersion(entityId, apiId, versionId));
  }

  /** The OpenAPI document of a version as uploaded (stored as JSON). */
  async getOpenapi(entityId: string, apiId: string, versionId: string): Promise<unknown> {
    return (await this.findVersion(entityId, apiId, versionId)).openapiSpec;
  }

  /**
   * Lints an OpenAPI document. APIs with personal or sensitive data must declare the data subject
   * of every operation (x-den-data-subject, ADR-0015) with the country's document types.
   */
  private lint(source: string, classification: string) {
    const config = getCountryConfig();
    return lintOpenApi(source, {
      noIdInQuery: config.features.lint.noIdInQuery,
      dataSubject: {
        required: classification === 'personal' || classification === 'sensitive',
        documentTypes: config.identifiers.person,
      },
    });
  }

  /**
   * What a version's upstream (or sandbox upstream) may name (M4-04, M4-05): a kit node of the same
   * entity still in the network, or a service of the entity's own X-Road member in the operator's
   * instance. The reconciler checks it again on every pass and fails closed. Its type is checked
   * before (assertUpstreamTypeAllowed, P-04).
   */
  private async assertUpstreamAllowed(
    entity: { id: string; xroadMemberClass: string | null; xroadMemberCode: string | null },
    upstream: Upstream,
    path: string,
  ): Promise<void> {
    // A version on a kit node names a node of the same entity that is still in the network
    // (M4-04); the reconciler checks it again on every pass and fails closed.
    if (upstream.type === 'node' && upstream.nodeId) {
      const node = await scopedRepo(this.prisma.node, entity.id).findFirst({
        where: { id: upstream.nodeId, status: { not: 'decommissioned' } },
        select: { id: true },
      });
      if (!node) {
        throw new ValidationError([
          {
            path: `${path}.nodeId`,
            message: 'Not a node of this entity in the network',
            key: FieldErrorKey.NotANodeOfEntity,
          },
        ]);
      }
    }
    // Every xroad route leaves with the operator's identity: an entity only publishes services
    // of its own X-Road member, which the operator set (M4-05, SPIKE S-5).
    if (upstream.type === 'xroad') {
      const { memberClass, memberCode } = upstream.serviceId;
      if (!entity.xroadMemberClass || !entity.xroadMemberCode) {
        throw new ValidationError([
          {
            path: `${path}.serviceId`,
            message: 'The operator has not registered the entity’s X-Road member yet',
            key: FieldErrorKey.XroadMemberMissing,
          },
        ]);
      }
      const instance = process.env.DEN_XROAD_CLIENT?.split('/')[0];
      if (instance && upstream.serviceId.instance !== instance) {
        throw new ValidationError([
          {
            path: `${path}.serviceId`,
            message: `The X-Road instance must be ${instance}`,
            key: FieldErrorKey.XroadWrongInstance,
            params: { instance },
          },
        ]);
      }
      if (memberClass !== entity.xroadMemberClass || memberCode !== entity.xroadMemberCode) {
        throw new ValidationError([
          {
            path: `${path}.serviceId`,
            message: 'The service is not of the entity’s X-Road member',
            key: FieldErrorKey.XroadOtherMember,
          },
        ]);
      }
    }
  }

  /**
   * What createVersion and updateVersion check of what the provider declares: the classification
   * covers the declared fields (M-20), the purposes exist, and the upstreams are allowed (type
   * first, P-04, then node or member).
   */
  private async assertDeclarationValid(
    entity: { id: string; xroadMemberClass: string | null; xroadMemberCode: string | null },
    classification: string,
    data: {
      allowedPurposes: string[];
      exposedFields: unknown;
      upstream: Upstream;
      sandboxUpstream?: Upstream | undefined;
    },
  ): Promise<void> {
    assertClassificationCoversFields(classification, data.exposedFields);
    const purposes = await this.prisma.purpose.findMany({
      where: { code: { in: data.allowedPurposes }, active: true },
      select: { code: true },
    });
    const unknown = data.allowedPurposes.filter((c) => !purposes.some((p) => p.code === c));
    if (unknown.length > 0) {
      throw new ValidationError(
        unknown.map((code) => ({
          path: 'allowedPurposes',
          message: `Unknown purpose "${code}"`,
          key: FieldErrorKey.UnknownPurpose,
          params: { code },
        })),
      );
    }
    // Type first for both, so a refused type is reported before node or member details.
    assertUpstreamTypeAllowed(data.upstream.type, 'upstream');
    if (data.sandboxUpstream)
      assertUpstreamTypeAllowed(data.sandboxUpstream.type, 'sandboxUpstream');
    await this.assertUpstreamAllowed(entity, data.upstream, 'upstream');
    if (data.sandboxUpstream) {
      await this.assertUpstreamAllowed(entity, data.sandboxUpstream, 'sandboxUpstream');
    }
  }

  async createVersion(
    entityId: string,
    apiId: string,
    principal: Principal,
    input: CreateApiVersionInput,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    await assertEntityActive(this.prisma, entityId);
    const data = createApiVersionSchema.parse(input);
    const api = await this.findApi(entityId, apiId);
    const entity = await this.prisma.entity.findUniqueOrThrow({ where: { id: entityId } });

    await this.assertDeclarationValid(entity, api.classification, data);

    const [major = 0, minor = 0] = data.version.split('.').map(Number);
    // One version per major until it is retired (ADR-0019): compatible changes are revisions of
    // the published version; anything else is a new major.
    const live = await this.prisma.apiVersion.findFirst({
      where: { apiId: api.id, major, status: { not: 'retired' } },
      select: { version: true, status: true },
    });
    if (live) {
      throw new ConflictError(
        `Major ${major} already has version ${live.version} (${live.status}); revise it or create major ${major + 1}`,
      );
    }
    const parsed = await this.lint(data.openapi, api.classification);

    try {
      const version = await this.prisma.$transaction(async (tx) => {
        const created = await tx.apiVersion.create({
          data: {
            apiId: api.id,
            version: data.version,
            major,
            minor,
            status: 'draft',
            openapiSpec: parsed.spec as Prisma.InputJsonObject,
            openapiSha256: parsed.sha256,
            openapiSha256Variants: parsed.sha256Variants,
            lintReport: parsed.report,
            upstreamType: data.upstream.type,
            upstream: data.upstream,
            ...(data.sandboxUpstream ? { sandboxUpstream: data.sandboxUpstream } : {}),
            basePath: `/${entity.slug}/${api.slug}/v${major}`,
            exposedFields: data.exposedFields,
            legalBasisText: data.legalBasisText ?? null,
            legalReferences: data.legalReferences,
            ...(data.defaultRateLimit ? { defaultRateLimit: data.defaultRateLimit } : {}),
            createdBy: principal.userId,
            allowedPurposes: {
              create: [...new Set(data.allowedPurposes)].map((purposeCode) => ({ purposeCode })),
            },
          },
          include: VERSION_INCLUDE,
        });
        await this.audit.record(tx, {
          actor: this.actor(principal, entityId),
          action: 'api_version.created',
          target: { type: 'api_version', id: created.id },
          after: versionSnapshot(created),
          requestId,
        });
        return created;
      });
      return this.detailOf(version);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Either the exact version exists or another live version holds the major (the database
        // index api_version_one_live_per_major covers a race the check above cannot).
        throw new ConflictError(
          `Version ${data.version} already exists for this API, or major ${major} already has a live version`,
        );
      }
      throw error;
    }
  }

  /**
   * Replaces what the provider declared in an editable version (draft or changes_requested, M-19):
   * the exposed fields, the legal basis, the purposes, the upstreams and, optionally, the OpenAPI
   * document. Same validation as createVersion; the version number does not change. Rejected
   * while the version is in review or beyond: a reviewer decides on what was submitted.
   */
  async updateVersion(
    entityId: string,
    apiId: string,
    versionId: string,
    principal: Principal,
    input: UpdateApiVersionInput,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    await assertEntityActive(this.prisma, entityId);
    const data = updateApiVersionSchema.parse(input);
    const before = await this.findVersion(entityId, apiId, versionId);
    if (!isEditable(before.status)) {
      throw new ConflictError(`A version in status ${before.status} cannot be edited`);
    }
    const api = await this.findApi(entityId, apiId);
    const entity = await this.prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
    await this.assertDeclarationValid(entity, api.classification, data);
    const parsed = data.openapi ? await this.lint(data.openapi, api.classification) : undefined;
    const purposeCodes = [...new Set(data.allowedPurposes)];

    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: before.status, updatedAt: before.updatedAt },
        data: {
          ...(parsed
            ? {
                openapiSpec: parsed.spec as Prisma.InputJsonObject,
                openapiSha256: parsed.sha256,
                openapiSha256Variants: parsed.sha256Variants,
                lintReport: parsed.report,
              }
            : {}),
          upstreamType: data.upstream.type,
          upstream: data.upstream,
          sandboxUpstream: data.sandboxUpstream ?? Prisma.DbNull,
          exposedFields: data.exposedFields,
          legalBasisText: data.legalBasisText ?? null,
          legalReferences: data.legalReferences,
          defaultRateLimit: data.defaultRateLimit ?? 600,
        },
      });
      if (changed.count === 0) throw new ConflictError('The version changed meanwhile; reload it');
      await tx.apiVersionPurpose.deleteMany({ where: { apiVersionId: versionId } });
      await tx.apiVersionPurpose.createMany({
        data: purposeCodes.map((purposeCode) => ({ apiVersionId: versionId, purposeCode })),
      });
      const after = await tx.apiVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: VERSION_INCLUDE,
      });
      await this.audit.record(tx, {
        actor: this.actor(principal, entityId),
        action: 'api_version.updated',
        target: { type: 'api_version', id: versionId },
        before: versionSnapshot(before),
        after: versionSnapshot(after),
        requestId,
      });
      return after;
    });
    return this.detailOf(updated);
  }

  /** Replaces the OpenAPI document of an editable version and lints it again. */
  async replaceOpenapi(
    entityId: string,
    apiId: string,
    versionId: string,
    principal: Principal,
    source: string,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    const before = await this.findVersion(entityId, apiId, versionId);
    if (before.status === 'published') {
      // A version whose upstream type is no longer accepted keeps serving, but is not changed
      // (P-04).
      assertStoredUpstreamsAllowed(before);
      return this.revise(entityId, apiId, before, principal, source, requestId);
    }
    if (!isEditable(before.status)) {
      throw new ConflictError(`A version in status ${before.status} cannot be edited`);
    }
    assertStoredUpstreamsAllowed(before);
    const api = await this.findApi(entityId, apiId);
    const parsed = await this.lint(source, api.classification);
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: before.status },
        data: {
          openapiSpec: parsed.spec as Prisma.InputJsonObject,
          openapiSha256: parsed.sha256,
          openapiSha256Variants: parsed.sha256Variants,
          lintReport: parsed.report,
        },
      });
      if (changed.count === 0) throw new ConflictError('The version changed meanwhile; reload it');
      const after = await tx.apiVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: VERSION_INCLUDE,
      });
      await this.audit.record(tx, {
        actor: this.actor(principal, entityId),
        action: 'api_version.openapi_replaced',
        target: { type: 'api_version', id: versionId },
        before: versionSnapshot(before),
        after: versionSnapshot(after),
        requestId,
      });
      return after;
    });
    return this.detailOf(updated);
  }

  /**
   * Compatible revision of a published version (ADR-0019): the DEN lint and the compatibility
   * check against the published document must pass. The same row moves to the next minor, so the
   * route and every subscription stay; the previous document is kept in api_version_revision.
   */
  private async revise(
    entityId: string,
    apiId: string,
    before: VersionRow,
    principal: Principal,
    source: string,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    await assertEntityActive(this.prisma, entityId);
    const api = await this.findApi(entityId, apiId);
    const parsed = await this.lint(source, api.classification);
    if (!parsed.report.valid) {
      throw new ValidationError(
        parsed.report.issues
          .filter((i) => i.severity === 'error')
          .map((issue) => ({
            path: 'line' in issue && issue.line ? `openapi:${issue.line}` : 'openapi',
            message: issue.message,
          })),
      );
    }
    if (parsed.sha256 === before.openapiSha256) {
      throw new ConflictError('The document is the same as the published one');
    }
    const breaking = breakingChanges(before.openapiSpec, parsed.spec);
    if (breaking.length > 0) {
      throw new ValidationError(
        breaking.map((message) => ({
          path: 'openapi',
          message: `Incompatible change (needs a new major version): ${message}`,
          key: FieldErrorKey.IncompatibleChange,
          params: { change: message },
        })),
      );
    }
    const minor = before.minor + 1;
    const version = `${before.major}.${minor}`;
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.apiVersionRevision.create({
          data: {
            apiVersionId: before.id,
            version: before.version,
            openapiSpec: before.openapiSpec as Prisma.InputJsonObject,
            openapiSha256: before.openapiSha256,
            replacedBy: principal.userId,
          },
        });
        const changed = await tx.apiVersion.updateMany({
          where: { id: before.id, status: 'published', minor: before.minor },
          data: {
            minor,
            version,
            openapiSpec: parsed.spec as Prisma.InputJsonObject,
            openapiSha256: parsed.sha256,
            openapiSha256Variants: parsed.sha256Variants,
            lintReport: parsed.report,
          },
        });
        if (changed.count === 0)
          throw new ConflictError('The version changed meanwhile; reload it');
        const after = await tx.apiVersion.findUniqueOrThrow({
          where: { id: before.id },
          include: VERSION_INCLUDE,
        });
        await this.audit.record(tx, {
          actor: this.actor(principal, entityId),
          action: 'api_version.revised',
          target: { type: 'api_version', id: before.id },
          before: versionSnapshot(before),
          after: versionSnapshot(after),
          requestId,
        });
        // New operations change the route's methods and the operations OPA recognises.
        for (const topic of [GATEWAY_SYNC_TOPIC, POLICY_SYNC_TOPIC]) {
          await this.outbox.enqueue(tx, {
            topic,
            aggregate: `apiVersion:${before.id}`,
            payload: { reason: 'revised' },
          });
        }
        return after;
      });
      return this.detailOf(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`Version ${version} already exists for this API`);
      }
      throw error;
    }
  }

  /**
   * published -> deprecated with a retirement date that respects the country's notice period
   * (lifecycle.apiRetirementNoticeDays, SPEC.md §4.2). The gateway announces it with Deprecation
   * and Sunset headers; new access requests are refused; VersionLifecycleService retires it.
   */
  async deprecate(
    entityId: string,
    apiId: string,
    versionId: string,
    principal: Principal,
    sunsetAt: Date,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    const before = await this.findVersion(entityId, apiId, versionId);
    assertTransition(before.status, 'deprecated');
    const days = getCountryConfig().lifecycle.apiRetirementNoticeDays;
    const now = new Date();
    const earliest = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    if (sunsetAt < earliest) {
      throw new ValidationError([
        {
          path: 'sunsetAt',
          message: `The retirement date must give at least ${days} days of notice (from ${earliest.toISOString().slice(0, 10)})`,
          key: FieldErrorKey.RetirementNotice,
          params: { days, from: earliest.toISOString().slice(0, 10) },
        },
      ]);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: 'published' },
        data: { status: 'deprecated', deprecatedAt: now, deprecatedBy: principal.userId, sunsetAt },
      });
      if (changed.count === 0) throw new ConflictError('The version changed meanwhile; reload it');
      await this.refreshApiStatus(tx, before.apiId);
      const after = await tx.apiVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: VERSION_INCLUDE,
      });
      await this.audit.record(tx, {
        actor: this.actor(principal, entityId),
        action: 'api_version.deprecated',
        target: { type: 'api_version', id: versionId },
        before: { status: before.status },
        after: { status: 'deprecated', sunsetAt: sunsetAt.toISOString() },
        requestId,
      });
      await this.outbox.enqueue(tx, {
        topic: GATEWAY_SYNC_TOPIC,
        aggregate: `apiVersion:${versionId}`,
        payload: { reason: 'deprecated' },
      });
      return after;
    });
    return this.detailOf(updated);
  }

  /**
   * The provider's data steward chooses which catalogue purposes a version allows (SPEC.md §2.2,
   * M2-10). Only active purposes; on any version that is not retired. Subscriptions already
   * granted keep their purpose: only new requests use the new list (OPA authorizes by the
   * subscription's purpose, not by this list).
   */
  async setPurposes(
    entityId: string,
    apiId: string,
    versionId: string,
    principal: Principal,
    codes: string[],
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    const before = await this.findVersion(entityId, apiId, versionId);
    if (before.status === 'retired') {
      throw new ConflictError('A retired version takes no changes');
    }
    const active = await this.prisma.purpose.findMany({
      where: { code: { in: codes }, active: true },
      select: { code: true },
    });
    const unknown = codes.filter((c) => !active.some((p) => p.code === c));
    if (unknown.length > 0) {
      throw new ValidationError(
        unknown.map((code) => ({
          path: 'allowedPurposes',
          message: `"${code}" is not an active purpose of the catalogue`,
          key: FieldErrorKey.InactivePurpose,
          params: { code },
        })),
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.apiVersionPurpose.deleteMany({ where: { apiVersionId: versionId } });
      await tx.apiVersionPurpose.createMany({
        data: codes.map((purposeCode) => ({ apiVersionId: versionId, purposeCode })),
      });
      const after = await tx.apiVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: VERSION_INCLUDE,
      });
      await this.audit.record(tx, {
        actor: this.actor(principal, entityId),
        action: 'api_version.purposes_changed',
        target: { type: 'api_version', id: versionId },
        before: { allowedPurposes: before.allowedPurposes.map((p) => p.purposeCode).sort() },
        after: { allowedPurposes: [...codes].sort() },
        requestId,
      });
      return after;
    });
    return this.detailOf(updated);
  }

  /** Api.status is derived from its versions (SPEC.md §3). */
  async refreshApiStatus(tx: Prisma.TransactionClient, apiId: string): Promise<void> {
    const statuses = new Set(
      (await tx.apiVersion.findMany({ where: { apiId }, select: { status: true } })).map(
        (v) => v.status,
      ),
    );
    const status = statuses.has('published')
      ? 'published'
      : statuses.has('deprecated')
        ? 'deprecated'
        : statuses.size > 0 && [...statuses].every((s) => s === 'retired')
          ? 'retired'
          : undefined;
    if (status) await tx.api.update({ where: { id: apiId }, data: { status } });
  }

  /** draft | changes_requested -> in_review. Blocked while the OpenAPI lint has errors. */
  async submit(
    entityId: string,
    apiId: string,
    versionId: string,
    principal: Principal,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    await assertEntityActive(this.prisma, entityId);
    const before = await this.findVersion(entityId, apiId, versionId);
    const target: ApiVersionStatus = 'in_review';
    assertTransition(before.status, target);
    assertStoredUpstreamsAllowed(before);
    // Rows from before M-20 may declare personal fields in a lower classification.
    assertClassificationCoversFields(
      (await this.findApi(entityId, apiId)).classification,
      before.exposedFields,
    );

    const report = before.lintReport as LintReport | null;
    if (!report?.valid) {
      const errors = (report?.issues ?? []).filter((i) => i.severity === 'error');
      throw new ValidationError(
        (errors.length ? errors : [{ message: 'The OpenAPI document has not been linted' }]).map(
          (issue) => ({
            path: 'line' in issue && issue.line ? `openapi:${issue.line}` : 'openapi',
            message: issue.message,
          }),
        ),
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: before.status },
        data: { status: target, submittedBy: principal.userId, submittedAt: new Date() },
      });
      if (changed.count === 0) throw new ConflictError('The version changed meanwhile; reload it');
      const after = await tx.apiVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: VERSION_INCLUDE,
      });
      await this.audit.record(tx, {
        actor: this.actor(principal, entityId),
        action: 'api_version.submitted',
        target: { type: 'api_version', id: versionId },
        before: versionSnapshot(before),
        after: versionSnapshot(after),
        requestId,
      });
      // Healthcheck and contract test through the gateway (M4-06), attached to the review.
      await this.validation.queueInTx(tx, versionId, 'submitted');
      return after;
    });
    return this.detailOf(await this.findVersion(entityId, apiId, updated.id));
  }

  /**
   * The validations touch a host the provider names (MB-2), before any human has looked at it, so
   * asking again is limited: a cooldown per version since the last run started, and a cap per
   * entity and hour (counted from the audit trail).
   */
  private async assertValidationAllowed(entityId: string, version: VersionRow): Promise<void> {
    if (!validationEnabled()) return;
    const s = validationSettings();
    const started = storedValidation(version.validationReport)?.startedAt;
    const waitMs = started ? Date.parse(started) + s.cooldownSeconds * 1000 - Date.now() : 0;
    let retryMs = waitMs;
    const recent = await this.prisma.auditEvent.count({
      where: {
        action: 'api_version.validation_requested',
        actorEntityId: entityId,
        occurredAt: { gt: new Date(Date.now() - 3_600_000) },
      },
    });
    if (recent >= s.maxPerHour) retryMs = Math.max(retryMs, 3_600_000);
    if (retryMs > 0) {
      const minutes = Math.max(1, Math.ceil(retryMs / 60_000));
      throw new RateLimitedError(
        `Validations were run recently: try again in about ${minutes} minutes`,
        { key: FieldErrorKey.ValidationRateLimited, params: { minutes } },
      );
    }
  }

  /** What a provider must serve to prove it controls its `direct` sandbox host (MB-2). */
  async hostProof(entityId: string, apiId: string, versionId: string): Promise<HostProof> {
    const version = await this.findVersion(entityId, apiId, versionId);
    const sandbox = version.sandboxUpstream
      ? upstreamSchema.safeParse(version.sandboxUpstream)
      : undefined;
    const token = validationSettings().token;
    if (!token || !sandbox?.success || sandbox.data.type !== 'direct') {
      return { required: false, url: null, token: null };
    }
    const url = new URL(sandbox.data.url);
    return {
      required: true,
      url: `${url.origin}${HOST_CONTROL_PATH}`,
      token: hostControlToken(token, entityId, url.hostname),
    };
  }

  /** Runs the validations again (the provider fixed its service) while the version is in review. */
  async revalidate(
    entityId: string,
    apiId: string,
    versionId: string,
    principal: Principal,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    const version = await this.findVersion(entityId, apiId, versionId);
    if (version.status !== 'in_review') {
      throw new ConflictError('Only a version in review is validated');
    }
    await this.assertValidationAllowed(entityId, version);
    await this.prisma.$transaction(async (tx) => {
      await this.audit.record(tx, {
        actor: this.actor(principal, entityId),
        action: 'api_version.validation_requested',
        target: { type: 'api_version', id: versionId },
        requestId,
      });
      await this.validation.queueInTx(tx, versionId, 'requested');
    });
    return this.detailOf(await this.findVersion(entityId, apiId, versionId));
  }
}
