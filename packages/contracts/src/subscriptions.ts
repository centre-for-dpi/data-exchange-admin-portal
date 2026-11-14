import { z } from 'zod';
import { classificationSchema, operationSchema } from './apis.js';
import { catalogPurposeSchema } from './catalog.js';
import { documentSummarySchema } from './entities.js';
import { pageOf } from './session.js';

/** Subscription lifecycle (SPEC.md §4.4). */
export const SUBSCRIPTION_STATUSES = [
  'pending_provider',
  'info_requested',
  'pending_regulator',
  'approved',
  'active',
  'suspended',
  'revoked',
  'expired',
  'rejected',
  'withdrawn',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

const operationIdSchema = z.string().trim().min(1).max(200);
const operationListSchema = z
  .array(operationIdSchema)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, 'operations must not repeat');

/** Access request by an app developer of the consumer entity (SPEC.md §4.4, step 1). */
export const createSubscriptionSchema = z.strictObject({
  applicationId: z.uuid(),
  apiVersionId: z.uuid(),
  purposeCode: z.string().trim().min(1).max(80),
  purposeDetail: z.string().trim().min(10).max(2_000),
  legalBasisText: z.string().trim().min(10).max(2_000),
  legalReference: z.string().trim().max(300).optional(),
  /** operationIds of the version; empty = every read-only operation (SPEC.md §3). */
  requestedOperations: operationListSchema.default([]),
  /** Requested validity in months; the maximum depends on the API classification (SPEC.md §5). */
  validityMonths: z.coerce.number().int().min(1).max(120),
  requestedRateLimit: z.coerce.number().int().min(1).max(100_000).optional(),
  /**
   * The active subscription this request renews (SPEC.md §4.4 step 6): same application, version
   * and purpose. It lives next to that subscription until approved (M2-06).
   */
  renewsSubscriptionId: z.uuid().optional(),
});
export type CreateSubscriptionInput = z.input<typeof createSubscriptionSchema>;

/**
 * Approval by the provider's data steward. Every field can only narrow what was requested:
 * fewer operations, shorter validity, lower rate limit (SPEC.md §4.4, step 2).
 */
export const approveSubscriptionSchema = z.strictObject({
  approvedOperations: operationListSchema.min(1).optional(),
  validityMonths: z.coerce.number().int().min(1).max(120).optional(),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(100_000).optional(),
  comment: z.string().trim().max(2_000).optional(),
});
export type ApproveSubscriptionInput = z.input<typeof approveSubscriptionSchema>;

export const rejectSubscriptionSchema = z.strictObject({
  comment: z
    .string()
    .trim()
    .min(10, 'explain why the request is rejected (10+ characters)')
    .max(2_000),
});
export type RejectSubscriptionInput = z.input<typeof rejectSubscriptionSchema>;

/** Revocation by the provider's data steward: final, with a reason the consumer reads. */
export const revokeSubscriptionSchema = z.strictObject({
  comment: z.string().trim().min(10, 'explain why access is revoked (10+ characters)').max(2_000),
});
export type RevokeSubscriptionInput = z.input<typeof revokeSubscriptionSchema>;

const entityRef = z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() });

export const subscriptionSummarySchema = z.object({
  id: z.uuid(),
  status: subscriptionStatusSchema,
  purpose: catalogPurposeSchema,
  application: z.object({
    id: z.uuid(),
    name: z.string(),
    clientId: z.string(),
    entity: entityRef,
  }),
  api: z.object({
    id: z.uuid(),
    name: z.string(),
    classification: classificationSchema,
    entity: entityRef,
  }),
  version: z.object({ id: z.uuid(), version: z.string(), basePath: z.string() }),
  requestedAt: z.iso.datetime(),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime(),
});
export type SubscriptionSummary = z.infer<typeof subscriptionSummarySchema>;

export const subscriptionDecisionSchema = z.object({
  decision: z.enum([
    'approved',
    'rejected',
    'info_requested',
    'suspended',
    'reactivated',
    'revoked',
    'info_provided',
    'withdrawn',
  ]),
  /**
   * provider = a data steward of the provider entity; platform = operator or regulator;
   * consumer = the requesting entity (answers and withdrawals).
   */
  by: z.enum(['provider', 'platform', 'consumer']),
  comment: z.string().nullable(),
  decidedAt: z.iso.datetime(),
});

export const subscriptionDetailSchema = subscriptionSummarySchema.extend({
  purposeDetail: z.string(),
  legalBasisText: z.string(),
  legalReference: z.string().nullable(),
  /** Every operation of the version, to show what was requested and granted. */
  operations: z.array(operationSchema),
  /** As requested; empty = every read-only operation. */
  requestedOperations: z.array(z.string()),
  /** Granted by the provider; empty until approved. */
  approvedOperations: z.array(z.string()),
  /** Read-only operations an empty request stands for. */
  effectiveRequestedOperations: z.array(z.string()),
  requestedValidityMonths: z.number().int(),
  maxValidityMonths: z.number().int(),
  requestedRateLimit: z.number().int().nullable(),
  rateLimitPerMinute: z.number().int().nullable(),
  defaultRateLimit: z.number().int(),
  endUserIdentificationRequired: z.boolean(),
  /** True when approving moves the request to the regulator (M2-04). */
  requiresRegulator: z.boolean(),
  decisions: z.array(subscriptionDecisionSchema),
  /** The subscription this request renews, if it is a renewal. */
  renewsSubscriptionId: z.uuid().nullable(),
  /** Exchange agreement (PDF) attached by the requester (M2-07). */
  agreementDocument: documentSummarySchema.nullable(),
  /** The live renewal of this subscription, if one was requested. */
  renewal: z.object({ id: z.uuid(), status: subscriptionStatusSchema }).nullable(),
});
export type SubscriptionDetail = z.infer<typeof subscriptionDetailSchema>;

export const subscriptionPageSchema = pageOf(subscriptionSummarySchema);

export const subscriptionListQuerySchema = z.strictObject({
  status: subscriptionStatusSchema.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SubscriptionListQuery = z.infer<typeof subscriptionListQuerySchema>;

export const subscriptionParamsSchema = z.strictObject({
  entityId: z.uuid(),
  subscriptionId: z.uuid(),
});

/** An access request waiting for the regulator (M2-04). */
export const regulatorSubscriptionItemSchema = z.object({
  id: z.uuid(),
  requestedAt: z.iso.datetime(),
  api: z.object({ id: z.uuid(), name: z.string(), classification: z.string() }),
  version: z.object({ id: z.uuid(), version: z.string() }),
  provider: z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() }),
  consumer: z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() }),
  purposeCode: z.string(),
});

/** The regulator's inbox: what waits for their approval (SPEC.md §6, M2-04). */
export const regulatorQueueSchema = z.object({
  apiVersions: z.array(
    z.object({
      versionId: z.uuid(),
      version: z.string(),
      operatorApprovedAt: z.iso.datetime().nullable(),
      api: z.object({ id: z.uuid(), name: z.string(), classification: z.string() }),
      entity: z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() }),
    }),
  ),
  subscriptions: z.array(regulatorSubscriptionItemSchema),
});
export type RegulatorQueue = z.infer<typeof regulatorQueueSchema>;

export const regulatorDecisionSchema = z.strictObject({
  comment: z.string().trim().max(2_000).optional(),
});
/** Sending a version back or rejecting a request always carries a reason. */
export const regulatorReasonSchema = z.strictObject({
  comment: z.string().trim().min(10, 'explain the reason (10+ characters)').max(2_000),
});
export const subscriptionIdParamsSchema = z.strictObject({ subscriptionId: z.uuid() });

// ---------------------------------------------------------------------------------------------
// Lifecycle (SPEC.md §4.4, M2-06)
// ---------------------------------------------------------------------------------------------

const reason = (what: string) => z.string().trim().min(10, `${what} (10+ characters)`).max(2_000);

/** The data steward asks the requester for information; the request goes back to them. */
export const requestInfoSchema = z.strictObject({ comment: reason('say what you need') });
/** The requester answers, and may correct the purpose detail and the legal basis. */
export const provideInfoSchema = z.strictObject({
  comment: reason('answer the question'),
  purposeDetail: z.string().trim().min(10).max(2_000).optional(),
  legalBasisText: z.string().trim().min(10).max(2_000).optional(),
});
export const withdrawSubscriptionSchema = z.strictObject({
  comment: z.string().trim().max(2_000).optional(),
});
export const suspendSubscriptionSchema = z.strictObject({ comment: reason('explain the reason') });
export const reactivateSubscriptionSchema = z.strictObject({
  comment: z.string().trim().max(2_000).optional(),
});

/** Deletion of a document's bytes by legal order (SPEC.md §5, M2-07). */
export const purgeDocumentSchema = z.strictObject({
  order: z.string().trim().min(5, 'reference the legal order').max(500),
});
export const documentIdParamsSchema = z.strictObject({ documentId: z.uuid() });
export const purgedDocumentSchema = z.object({ id: z.uuid(), purgedAt: z.iso.datetime() });

export const DOCUMENT_KINDS = ['designation', 'agreement', 'annex', 'other'] as const;
export const documentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof documentKindSchema>;

/** The operator's register of attached documents: metadata only, never the bytes (M2-07). */
export const documentListQuerySchema = z.strictObject({
  ownerEntityId: z.uuid().optional(),
  kind: documentKindSchema.optional(),
  purged: z.enum(['true', 'false']).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const documentRecordSchema = documentSummarySchema.extend({
  kind: documentKindSchema,
  owner: z.object({ id: z.uuid(), shortName: z.string(), slug: z.string() }),
  purgedAt: z.iso.datetime().nullable(),
  purgeOrder: z.string().nullable(),
});
export type DocumentRecord = z.infer<typeof documentRecordSchema>;
export const documentPageSchema = pageOf(documentRecordSchema);
