import { z } from 'zod';
import { ValidationMessage } from './validation-messages.js';
import { isPublicHostname } from './net.js';
import { pageOf } from './session.js';

export const CLASSIFICATIONS = ['public', 'internal', 'personal', 'sensitive'] as const;
export const classificationSchema = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof classificationSchema>;

export const API_VERSION_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved_operator',
  'approved_regulator',
  'published',
  'deprecated',
  'retired',
] as const;
export const apiVersionStatusSchema = z.enum(API_VERSION_STATUSES);
export type ApiVersionStatus = z.infer<typeof apiVersionStatusSchema>;

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, ValidationMessage.api_slug_format);

/**
 * Where the data subject of an operation is (OpenAPI extension `x-den-data-subject`, ADR-0015,
 * ADR-0017): a path parameter, a JSON pointer into the request body (read by the gateway, never
 * asserted by the consumer), or none. The document type is fixed (`documentType`), read from
 * another path parameter or body field (`documentTypeParam`, `documentTypePointer`), or the
 * country's default person document type.
 */
export const dataSubjectSchema = z.discriminatedUnion('in', [
  z.object({
    in: z.literal('path'),
    name: z.string(),
    documentType: z.string().optional(),
    documentTypeParam: z.string().optional(),
  }),
  z.object({
    in: z.literal('body'),
    pointer: z.string(),
    documentType: z.string().optional(),
    documentTypePointer: z.string().optional(),
  }),
  z.object({ in: z.literal('none') }),
]);
export type DataSubject = z.infer<typeof dataSubjectSchema>;

/** An operation of an OpenAPI document; `dataSubject` is null when it is not declared. */
export const operationSchema = z.object({
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  dataSubject: dataSubjectSchema.nullable(),
});
export type Operation = z.infer<typeof operationSchema>;

/**
 * One part of an X-Road identifier (SPIKE S-5): letters, digits, spaces and `. _ - : ~`, no
 * spaces at the ends. They go literally into the gateway's URL rewrite, which encodes them, so
 * `/`, `%`, `?`, `#` and `$` are never allowed.
 */
export const xroadPartSchema = z
  .string()
  .max(255)
  .regex(
    /^[\p{L}\p{N}._~:-](?:[\p{L}\p{N} ._~:-]*[\p{L}\p{N}._~:-])?$/u,
    'letters, digits, spaces and . _ - : ~ only',
  )
  // Only dots would be a path segment the Security Server could resolve as `.` or `..`.
  .refine((part) => !/^\.+$/.test(part), { error: ValidationMessage.not_only_dots });

/**
 * Path after an X-Road serviceId: empty, or segments of letters, digits and `. _ ~ -`, none empty
 * and none `.` or `..` (they could leave the serviceId on the Security Server).
 */
export const xroadServicePathSchema = z
  .string()
  .max(500)
  .regex(
    /^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/,
    'empty, or an absolute path without empty, . or .. segments',
  );

/** X-Road member: class and code (e.g. GOV / 8999999999). */
export const xroadMemberSchema = z.strictObject({
  memberClass: xroadPartSchema,
  memberCode: xroadPartSchema,
});
export type XroadMember = z.infer<typeof xroadMemberSchema>;

/** X-Road service identifier (PR-REST serviceId). */
export const xroadServiceIdSchema = z.strictObject({
  instance: xroadPartSchema,
  memberClass: xroadPartSchema,
  memberCode: xroadPartSchema,
  subsystemCode: xroadPartSchema.optional(),
  serviceCode: xroadPartSchema,
});
export type XroadServiceId = z.infer<typeof xroadServiceIdSchema>;

/** `/r1/{instance}/{class}/{member}[/{subsystem}]/{service}` (PR-REST 1.0, SPIKE S-5). */
export const xroadServicePath = (id: XroadServiceId): string =>
  `/r1/${[id.instance, id.memberClass, id.memberCode, id.subsystemCode, id.serviceCode]
    .filter((part): part is string => part !== undefined)
    .join('/')}`;

/**
 * How a provider's service reaches the gateway (SPEC.md §3.1). Which ones a deployment accepts for
 * new versions is the country's `features.upstreams`, with `xroad` only where the deployment has
 * the operator's Security Server (P-04, ADR-0029).
 */
export const UPSTREAM_TYPES = ['node', 'xroad', 'direct'] as const;
export const upstreamTypeSchema = z.enum(UPSTREAM_TYPES);
export type UpstreamType = z.infer<typeof upstreamTypeSchema>;

/** The upstream types new versions may use in this deployment (P-04), node first. */
export const upstreamTypesSchema = z.object({ allowed: z.array(upstreamTypeSchema) });
export type UpstreamTypes = z.infer<typeof upstreamTypesSchema>;

/** Where the service lives (SPEC.md §3.1). */
export const upstreamSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('direct'),
    /** Existing HTTPS API of the entity. */
    url: z
      .url({ protocol: /^https$/, error: ValidationMessage.https_url })
      .refine((value) => isPublicHostname(new URL(value).hostname), {
        error: ValidationMessage.public_host_required,
      }),
    mtls: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal('node'),
    /**
     * Enrolled node of the instant-APIs kit (M4-04). Without it, a development stand-in serves
     * the version (DEN_DEV_NODES).
     */
    nodeId: z.uuid().optional(),
    /** Path of the service on the node, e.g. /salud */
    servicePath: z.string().regex(/^\/[A-Za-z0-9._~\-/]*$/, ValidationMessage.absolute_path),
  }),
  z.strictObject({
    type: z.literal('xroad'),
    /**
     * Service of the provider in X-Road, called through the operator's Security Server
     * (M4-05, SPIKE S-5). Its member must be the publishing entity's X-Road member.
     */
    serviceId: xroadServiceIdSchema,
    /** Path of the service after the serviceId, e.g. /v1; empty by default. */
    servicePath: xroadServicePathSchema.default(''),
  }),
]);
export type Upstream = z.infer<typeof upstreamSchema>;

/** Personal data an API exposes, reviewed for minimization (SPEC.md §5). */
export const exposedFieldSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  personal: z.boolean(),
  sensitive: z.boolean(),
});
export type ExposedField = z.infer<typeof exposedFieldSchema>;

export const createApiSchema = z.strictObject({
  slug,
  name: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(10).max(300),
  /** Markdown. */
  description: z.string().trim().min(10).max(20_000),
  /** Sector code from the country config. */
  sector: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  classification: classificationSchema,
  ownerContact: z.email(),
});
export type CreateApiInput = z.input<typeof createApiSchema>;

/** OpenAPI 3.x as YAML or JSON text. */
export const openapiSourceSchema = z.string().min(20).max(900_000);

export const createApiVersionSchema = z.strictObject({
  version: z.string().regex(/^[1-9][0-9]{0,2}\.[0-9]{1,3}$/, ValidationMessage.version_format),
  openapi: openapiSourceSchema,
  upstream: upstreamSchema,
  /** Optional test upstream with synthetic data (M4-06, M4-08). */
  sandboxUpstream: upstreamSchema.optional(),
  exposedFields: z.array(exposedFieldSchema).max(200).default([]),
  allowedPurposes: z.array(z.string().min(1)).min(1).max(20),
  legalBasisText: z.string().trim().max(5_000).optional(),
  legalReferences: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  defaultRateLimit: z.number().int().min(1).max(100_000).optional(),
});
export type CreateApiVersionInput = z.input<typeof createApiVersionSchema>;

/** Replaces the OpenAPI document of a draft version (re-linted). */
export const replaceOpenapiSchema = z.strictObject({ openapi: openapiSourceSchema });

export const lintIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  path: z.array(z.string()),
  /** 1-based line in the uploaded document. */
  line: z.number().int().optional(),
});
export type LintIssue = z.infer<typeof lintIssueSchema>;

export const lintReportSchema = z.object({
  valid: z.boolean(),
  issues: z.array(lintIssueSchema),
});
export type LintReport = z.infer<typeof lintReportSchema>;

export const apiVersionSummarySchema = z.object({
  id: z.uuid(),
  version: z.string(),
  status: apiVersionStatusSchema,
  basePath: z.string(),
  updatedAt: z.iso.datetime(),
});

export const apiSummarySchema = z.object({
  id: z.uuid(),
  entityId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  sector: z.string(),
  classification: classificationSchema,
  status: z.enum(['draft', 'published', 'deprecated', 'retired']),
  updatedAt: z.iso.datetime(),
});
export type ApiSummary = z.infer<typeof apiSummarySchema>;

export const apiDetailSchema = apiSummarySchema.extend({
  description: z.string(),
  tags: z.array(z.string()),
  ownerContact: z.string(),
  versions: z.array(apiVersionSummarySchema),
});
export type ApiDetail = z.infer<typeof apiDetailSchema>;

/** A decision of the operator (or regulator) on a version, visible to the provider. */
export const versionReviewSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  reviewerRole: z.enum(['platform_admin', 'platform_reviewer', 'regulator', 'auditor']),
  comment: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type VersionReview = z.infer<typeof versionReviewSchema>;

/**
 * Automatic validations when a version is sent to review (SPEC.md §4.2 step 2, M4-06). The
 * contract test keeps only, per operation, the Schemathesis check codes that failed and the status
 * received: never a body (CLAUDE.md, rule 2).
 */
export const versionValidationSchema = z.object({
  status: z.enum(['running', 'passed', 'failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  healthcheck: z
    .object({
      status: z.enum(['passed', 'failed']),
      httpStatus: z.number().int().nullable(),
      latencyMs: z.number().int().nullable(),
      reason: z.string().optional(),
    })
    .nullable(),
  contract: z
    .object({
      status: z.enum(['passed', 'failed', 'error', 'skipped']),
      reason: z.string().optional(),
      durationMs: z.number().int().optional(),
      operations: z.array(
        z.object({
          operation: z.string(),
          passed: z.boolean(),
          codes: z.array(z.string()),
          receivedStatus: z.number().int().nullable(),
        }),
      ),
    })
    .nullable(),
});
export type VersionValidation = z.infer<typeof versionValidationSchema>;

/** State of the kit node a version is served by (SPEC.md §4.6 step 5, M4-04). */
export const upstreamNodeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['enrollment_issued', 'enrolled', 'online', 'offline', 'decommissioned']),
  lastHeartbeatAt: z.iso.datetime().nullable(),
});
export type UpstreamNode = z.infer<typeof upstreamNodeSchema>;

export const apiVersionDetailSchema = apiVersionSummarySchema.extend({
  apiId: z.uuid(),
  upstream: upstreamSchema,
  /** The kit node of a `node` upstream with a nodeId; null otherwise. */
  node: upstreamNodeSchema.nullable(),
  sandboxUpstream: upstreamSchema.nullable(),
  /**
   * Types of its upstream or sandbox upstream that this deployment no longer accepts for new
   * versions (P-04): the version keeps working, and the operator decides. Empty when all are.
   */
  disallowedUpstreamTypes: z.array(upstreamTypeSchema),
  /** Automatic validations at submission (M4-06); null until the first run. */
  validation: versionValidationSchema.nullable(),
  exposedFields: z.array(exposedFieldSchema),
  allowedPurposes: z.array(z.string()),
  legalBasisText: z.string().nullable(),
  legalReferences: z.array(z.string()),
  defaultRateLimit: z.number().int(),
  openapiSha256: z.string(),
  lintReport: lintReportSchema,
  operations: z.array(operationSchema),
  submittedAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  /** Lifecycle (ADR-0019): deprecation, planned retirement and actual retirement. */
  deprecatedAt: z.iso.datetime().nullable(),
  sunsetAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  /** Earlier documents replaced by compatible revisions, oldest first. */
  revisions: z.array(
    z.object({ version: z.string(), openapiSha256: z.string(), replacedAt: z.iso.datetime() }),
  ),
  reviews: z.array(versionReviewSchema),
});
export type ApiVersionDetail = z.infer<typeof apiVersionDetailSchema>;

export const apiPageSchema = pageOf(apiSummarySchema);

export const apiParamsSchema = z.strictObject({ entityId: z.uuid(), apiId: z.uuid() });
export const apiVersionParamsSchema = z.strictObject({
  entityId: z.uuid(),
  apiId: z.uuid(),
  versionId: z.uuid(),
});

export const purposeSchema = z.object({
  code: z.string(),
  name: z.union([z.string(), z.object({ es: z.string().optional(), en: z.string().optional() })]),
  description: z.union([
    z.string(),
    z.object({ es: z.string().optional(), en: z.string().optional() }),
  ]),
  legalReference: z.string().nullable(),
});
export const purposeListSchema = z.object({ items: z.array(purposeSchema) });

// ---------------------------------------------------------------------------------------------
// Operator review (SPEC.md §4.2, M1-04)
// ---------------------------------------------------------------------------------------------

export const reviewQueueItemSchema = z.object({
  versionId: z.uuid(),
  version: z.string(),
  status: apiVersionStatusSchema,
  submittedAt: z.iso.datetime().nullable(),
  api: z.object({ id: z.uuid(), name: z.string(), classification: classificationSchema }),
  entity: z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() }),
});
/** The review queue by pages, oldest first (M6-11): `nextCursor` while there are more. */
export const reviewQueueSchema = z.object({
  items: z.array(reviewQueueItemSchema),
  nextCursor: z.uuid().nullable(),
});
export const reviewQueueQuerySchema = z.strictObject({
  status: apiVersionStatusSchema.default('in_review'),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const reviewDetailSchema = z.object({
  entity: z.object({
    id: z.uuid(),
    slug: z.string(),
    shortName: z.string(),
    legalName: z.string(),
  }),
  api: z.object({
    id: z.uuid(),
    name: z.string(),
    summary: z.string(),
    description: z.string(),
    sector: z.string(),
    classification: classificationSchema,
    ownerContact: z.string(),
  }),
  version: apiVersionDetailSchema,
  /** True when this decision must also go through the regulator (SPEC.md §4.2, M2-04). */
  requiresRegulator: z.boolean(),
});
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

export const approveVersionSchema = z.strictObject({
  comment: z.string().trim().max(2_000).optional(),
});
export const requestChangesSchema = z.strictObject({
  comment: z.string().trim().min(10, ValidationMessage.explain_changes).max(2_000),
});
export const versionIdParamsSchema = z.strictObject({ versionId: z.uuid() });

/** Deprecation of a published version (ADR-0019): the planned retirement date. */
export const deprecateVersionSchema = z.strictObject({
  sunsetAt: z.iso.datetime({ offset: true }),
});

// ---------------------------------------------------------------------------------------------
// Purpose catalogue administration (SPEC.md §3, M2-10)
// ---------------------------------------------------------------------------------------------

const purposeText = (min: number, max: number) =>
  z.strictObject({
    es: z.string().trim().min(min).max(max),
    en: z.string().trim().min(min).max(max),
  });

export const purposeAdminSchema = purposeSchema.extend({
  /** config: defined in the country configuration (edited there); operator: added in the portal. */
  source: z.enum(['config', 'operator']),
  active: z.boolean(),
  /** Versions that allow it and subscriptions that use it (not retired / still live). */
  usage: z.object({ versions: z.number().int(), subscriptions: z.number().int() }),
});
export type PurposeAdmin = z.infer<typeof purposeAdminSchema>;
export const purposeAdminListSchema = z.object({ items: z.array(purposeAdminSchema) });

export const createPurposeSchema = z.strictObject({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, ValidationMessage.purpose_code_format)
    .max(60),
  name: purposeText(3, 120),
  description: purposeText(10, 1_000),
  legalReference: z.string().trim().max(300).optional(),
});
export const updatePurposeSchema = createPurposeSchema.omit({ code: true });
export const purposeCodeParamsSchema = z.strictObject({ code: z.string().regex(/^[a-z0-9_]+$/) });

/** The data steward chooses which catalogue purposes a version allows (SPEC.md §2.2). */
export const setVersionPurposesSchema = z.strictObject({
  allowedPurposes: z
    .array(z.string().regex(/^[a-z0-9_]+$/))
    .min(1)
    .max(50)
    .refine((codes) => new Set(codes).size === codes.length, ValidationMessage.each_purpose_once),
});
