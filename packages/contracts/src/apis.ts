import { z } from 'zod';
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

const slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, 'lower-case letters, digits and hyphens (3-40)');

/** Header that carries the data subject when the identifier travels in the body (ADR-0015). */
export const DATA_SUBJECT_HEADER = 'X-RID-Data-Subject';

/**
 * Where the data subject of an operation is (OpenAPI extension `x-rid-data-subject`, ADR-0015):
 * a path parameter, the X-RID-Data-Subject header (identifier in the body), or none. The document
 * type is fixed (`documentType`), read from another path parameter (`documentTypeParam`), or the
 * country's default person document type.
 */
export const dataSubjectSchema = z.discriminatedUnion('in', [
  z.object({
    in: z.literal('path'),
    name: z.string(),
    documentType: z.string().optional(),
    documentTypeParam: z.string().optional(),
  }),
  z.object({ in: z.literal('header'), documentType: z.string().optional() }),
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

/** Where the service lives (SPEC.md §3.1). X-Road arrives with M4-05. */
export const upstreamSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('direct'),
    /** Existing HTTPS API of the entity. */
    url: z
      .url({ protocol: /^https$/, error: 'must be an https:// URL' })
      .refine((value) => isPublicHostname(new URL(value).hostname), {
        error: 'must be a public host name or IP, not an internal address',
      }),
    mtls: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal('node'),
    /** Node of the instant-APIs kit (M4). Until nodes exist, the development mock stands in. */
    nodeId: z.uuid().optional(),
    /** Path of the service on the node, e.g. /salud */
    servicePath: z.string().regex(/^\/[A-Za-z0-9._~\-/]*$/, 'must be an absolute path'),
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
  version: z.string().regex(/^[1-9][0-9]{0,2}\.[0-9]{1,3}$/, 'major.minor, e.g. 1.0'),
  openapi: openapiSourceSchema,
  upstream: upstreamSchema,
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

export const apiVersionDetailSchema = apiVersionSummarySchema.extend({
  apiId: z.uuid(),
  upstream: upstreamSchema,
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
export const reviewQueueSchema = z.object({ items: z.array(reviewQueueItemSchema) });
export const reviewQueueQuerySchema = z.strictObject({
  status: apiVersionStatusSchema.default('in_review'),
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
  comment: z.string().trim().min(10, 'explain what has to change (10+ characters)').max(2_000),
});
export const versionIdParamsSchema = z.strictObject({ versionId: z.uuid() });
