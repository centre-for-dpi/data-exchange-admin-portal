import { Injectable } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import type {
  ApiDetail,
  ApiSummary,
  ApiVersionDetail,
  ApiVersionStatus,
  CreateApiInput,
  CreateApiVersionInput,
  LintReport,
  PaginationQuery,
} from '@rid/contracts';
import { createApiSchema, createApiVersionSchema, upstreamSchema } from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { assertTransition, isEditable } from '../domain/api-version/state-machine.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';
import { lintOpenApi, listOperations } from './lint/openapi-lint.js';

type ApiRow = Prisma.ApiGetPayload<object>;
export const VERSION_INCLUDE = {
  allowedPurposes: true,
  reviews: { orderBy: { createdAt: 'asc' } },
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
    const data = createApiSchema.parse(input);
    const sectors = getCountryConfig().sectors.map((s) => s.code);
    if (!sectors.includes(data.sector)) {
      throw new ValidationError([{ path: 'sector', message: `Unknown sector "${data.sector}"` }]);
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

  toVersionDetail(v: VersionRow): ApiVersionDetail {
    return {
      id: v.id,
      apiId: v.apiId,
      version: v.version,
      status: v.status,
      basePath: v.basePath,
      updatedAt: v.updatedAt.toISOString(),
      upstream: upstreamSchema.parse(v.upstream),
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
      reviews: v.reviews.map((r) => ({
        decision: r.decision,
        reviewerRole: r.reviewerRole,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async getVersion(entityId: string, apiId: string, versionId: string): Promise<ApiVersionDetail> {
    return this.toVersionDetail(await this.findVersion(entityId, apiId, versionId));
  }

  /** The OpenAPI document of a version as uploaded (stored as JSON). */
  async getOpenapi(entityId: string, apiId: string, versionId: string): Promise<unknown> {
    return (await this.findVersion(entityId, apiId, versionId)).openapiSpec;
  }

  private lint(source: string) {
    return lintOpenApi(source, { noIdInQuery: getCountryConfig().features.lint.noIdInQuery });
  }

  async createVersion(
    entityId: string,
    apiId: string,
    principal: Principal,
    input: CreateApiVersionInput,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    const data = createApiVersionSchema.parse(input);
    const api = await this.findApi(entityId, apiId);
    const entity = await this.prisma.entity.findUniqueOrThrow({ where: { id: entityId } });

    const purposes = await this.prisma.purpose.findMany({
      where: { code: { in: data.allowedPurposes }, active: true },
      select: { code: true },
    });
    const unknown = data.allowedPurposes.filter((c) => !purposes.some((p) => p.code === c));
    if (unknown.length > 0) {
      throw new ValidationError(
        unknown.map((code) => ({ path: 'allowedPurposes', message: `Unknown purpose "${code}"` })),
      );
    }

    const [major = 0, minor = 0] = data.version.split('.').map(Number);
    const parsed = await this.lint(data.openapi);

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
            lintReport: parsed.report,
            upstreamType: data.upstream.type,
            upstream: data.upstream,
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
      return this.toVersionDetail(version);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`Version ${data.version} already exists for this API`);
      }
      throw error;
    }
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
    if (!isEditable(before.status)) {
      throw new ConflictError(`A version in status ${before.status} cannot be edited`);
    }
    const parsed = await this.lint(source);
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: before.status },
        data: {
          openapiSpec: parsed.spec as Prisma.InputJsonObject,
          openapiSha256: parsed.sha256,
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
    return this.toVersionDetail(updated);
  }

  /** draft | changes_requested -> in_review. Blocked while the OpenAPI lint has errors. */
  async submit(
    entityId: string,
    apiId: string,
    versionId: string,
    principal: Principal,
    requestId?: string,
  ): Promise<ApiVersionDetail> {
    const before = await this.findVersion(entityId, apiId, versionId);
    const target: ApiVersionStatus = 'in_review';
    assertTransition(before.status, target);

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
      return after;
    });
    return this.toVersionDetail(updated);
  }
}
