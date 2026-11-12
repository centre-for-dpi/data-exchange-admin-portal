import { z } from 'zod';
import { classificationSchema } from './apis.js';
import { catalogPurposeSchema } from './catalog.js';
import { pageOf } from './session.js';

/** Subscription lifecycle (SPEC.md §4.4). */
export const SUBSCRIPTION_STATUSES = [
  'pending_provider',
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
  ]),
  /** provider = a data steward of the provider entity; platform = operator or regulator. */
  by: z.enum(['provider', 'platform']),
  comment: z.string().nullable(),
  decidedAt: z.iso.datetime(),
});

export const subscriptionDetailSchema = subscriptionSummarySchema.extend({
  purposeDetail: z.string(),
  legalBasisText: z.string(),
  legalReference: z.string().nullable(),
  /** Every operation of the version, to show what was requested and granted. */
  operations: z.array(z.object({ operationId: z.string(), method: z.string(), path: z.string() })),
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
