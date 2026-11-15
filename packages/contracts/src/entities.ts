import { z } from 'zod';
import { xroadMemberSchema } from './apis.js';
import { type EntityRole, entityRoleSchema, platformRoleSchema } from './roles.js';

/** SPEC.md §4.1. */
export const ENTITY_STATUSES = [
  'requested',
  'under_review',
  'active',
  'rejected',
  'suspended',
  'offboarded',
] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];
export const entityStatusSchema = z.enum(ENTITY_STATUSES);

export const ENTITY_KINDS = [
  'national',
  'territorial',
  'autonomous',
  'private_authorized',
] as const;
export const entityKindSchema = z.enum(ENTITY_KINDS);

/** Responsibilities an onboarding request designates (SPEC.md §4.1). */
export const DESIGNEE_ROLES = ['data_steward', 'technical_lead'] as const;
export type DesigneeRole = (typeof DESIGNEE_ROLES)[number];
export const designeeRoleSchema = z.enum(DESIGNEE_ROLES);

/** Entity roles each designee is invited with when the entity is approved. */
export const DESIGNEE_ENTITY_ROLES: Record<DesigneeRole, readonly EntityRole[]> = {
  data_steward: ['data_steward'],
  technical_lead: ['api_publisher', 'app_developer'],
};

/**
 * First segment of every gateway path (/{entitySlug}/{apiSlug}/v{major}), so it cannot collide
 * with the paths the platform itself uses.
 */
export const RESERVED_ENTITY_SLUGS = [
  'admin',
  'api',
  'apisix',
  'auth',
  'gw',
  'health',
  'internal',
  'metrics',
  'opa',
  'rid',
  'status',
  'well-known',
] as const;

export const entitySlugSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lower-case letters, digits and single hyphens')
  .refine((s) => !(RESERVED_ENTITY_SLUGS as readonly string[]).includes(s), 'reserved name');

/** E-mail addresses are compared and stored in lower case. */
export const emailSchema = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());

const personName = z.string().trim().min(3).max(120);

export const designeeInputSchema = z.strictObject({
  fullName: personName,
  email: emailSchema,
});

/** What the applicant fills in (POST/PUT /entity-requests). */
export const entityRequestInputSchema = z.strictObject({
  legalName: z.string().trim().min(3).max(200),
  shortName: z.string().trim().min(2).max(60),
  slug: entitySlugSchema,
  /** One of the country config's identifiers.organization. */
  taxIdType: z.string().trim().min(1).max(20),
  taxId: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z][0-9A-Za-z.-]{2,29}$/, 'digits, letters, dots and hyphens'),
  kind: entityKindSchema,
  /** A sector code from the country config. */
  sector: z.string().trim().min(1).max(40),
  contactEmail: emailSchema,
  website: z
    .url({ protocol: /^https$/ })
    .max(300)
    .nullish(),
  dpoName: personName,
  dpoEmail: emailSchema,
  designees: z.strictObject({
    data_steward: designeeInputSchema,
    technical_lead: designeeInputSchema,
  }),
});
export type EntityRequestInput = z.input<typeof entityRequestInputSchema>;

export const documentSummarySchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  uploadedAt: z.iso.datetime(),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const ENTITY_REVIEW_DECISIONS = [
  'approved',
  'changes_requested',
  'rejected',
  'suspended',
  'reactivated',
  'offboarded',
] as const;

export const entityReviewSchema = z.object({
  decision: z.enum(ENTITY_REVIEW_DECISIONS),
  reviewerRole: platformRoleSchema,
  comment: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const entityRequestSchema = z.object({
  id: z.uuid(),
  status: entityStatusSchema,
  slug: z.string(),
  legalName: z.string(),
  shortName: z.string(),
  taxIdType: z.string(),
  taxId: z.string(),
  kind: entityKindSchema,
  sector: z.string(),
  contactEmail: z.string(),
  website: z.string().nullable(),
  dpoName: z.string(),
  dpoEmail: z.string(),
  designees: z.array(
    z.object({ role: designeeRoleSchema, fullName: z.string(), email: z.string() }),
  ),
  designationDocument: documentSummarySchema.nullable(),
  applicant: z.object({ id: z.uuid(), fullName: z.string(), email: z.string() }).nullable(),
  submittedAt: z.iso.datetime().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** Operator decisions, oldest first. */
  reviews: z.array(entityReviewSchema),
});
export type EntityRequest = z.infer<typeof entityRequestSchema>;

export const entityRequestItemSchema = z.object({
  id: z.uuid(),
  status: entityStatusSchema,
  slug: z.string(),
  shortName: z.string(),
  legalName: z.string(),
  submittedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export const entityRequestListSchema = z.object({ items: z.array(entityRequestItemSchema) });
export type EntityRequestList = z.infer<typeof entityRequestListSchema>;

export const entityRequestIdParamsSchema = z.strictObject({ requestId: z.uuid() });

export const entityReviewQueueQuerySchema = z.strictObject({
  status: z.enum(['requested', 'under_review', 'active', 'rejected']).default('under_review'),
});

export const approveEntitySchema = z.strictObject({
  comment: z.string().trim().max(2_000).optional(),
});
/** Asking for corrections or rejecting always needs a reason the applicant can read. */
export const entityDecisionWithReasonSchema = z.strictObject({
  comment: z.string().trim().min(10, 'explain the reason (10+ characters)').max(2_000),
});

/** Name shown for an uploaded file; never used as a path. */
export const documentFileNameQuerySchema = z.strictObject({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      // No path separators and no control characters (U+0000-U+001F, U+007F).
      (name) =>
        !/[/\\]/.test(name) &&
        ![...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
      'a file name without path separators or control characters',
    )
    .default('document.pdf'),
});

export const invitationSchema = z.object({
  id: z.uuid(),
  entity: z.object({
    id: z.uuid(),
    slug: z.string(),
    shortName: z.string(),
    legalName: z.string(),
  }),
  roles: z.array(entityRoleSchema),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationListSchema = z.object({ items: z.array(invitationSchema) });
export const invitationIdParamsSchema = z.strictObject({ invitationId: z.uuid() });

// ---------------------------------------------------------------------------------------------
// Members and invitations managed by the entity_admin (M2-02)
// ---------------------------------------------------------------------------------------------

const entityRolesSchema = z
  .array(entityRoleSchema)
  .min(1, 'choose at least one role')
  .max(5)
  .refine((roles) => new Set(roles).size === roles.length, 'each role once');

export const inviteMemberSchema = z.strictObject({
  email: emailSchema,
  fullName: z.string().trim().min(3).max(120).optional(),
  roles: entityRolesSchema,
});
export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'revoked'] as const;

export const entityInvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
  roles: z.array(entityRoleSchema),
  status: z.enum(INVITATION_STATUSES),
  /** A pending invitation past this instant can no longer be accepted. */
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type EntityInvitation = z.infer<typeof entityInvitationSchema>;
export const entityInvitationListSchema = z.object({ items: z.array(entityInvitationSchema) });

export const updateMemberRolesSchema = z.strictObject({ roles: entityRolesSchema });

export const entityInvitationParamsSchema = z.strictObject({
  entityId: z.uuid(),
  invitationId: z.uuid(),
});
export const entityMemberParamsSchema = z.strictObject({
  entityId: z.uuid(),
  membershipId: z.uuid(),
});

// ---------------------------------------------------------------------------------------------
// Suspension and offboarding of entities by the operator (SPEC.md §4.1 step 4, M2-11)
// ---------------------------------------------------------------------------------------------

export const adminEntitySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  shortName: z.string(),
  legalName: z.string(),
  status: entityStatusSchema,
  providerSuspended: z.boolean(),
  /** X-Road member, set by the operator (M4-05); null when the entity is not in X-Road. */
  xroadMember: xroadMemberSchema.nullable(),
  counts: z.object({
    members: z.number().int(),
    publishedApis: z.number().int(),
    liveSubscriptions: z.number().int(),
  }),
});
export const adminEntityListSchema = z.object({ items: z.array(adminEntitySchema) });
export const adminEntityQuerySchema = z.strictObject({
  status: z.enum(['active', 'suspended', 'offboarded']).optional(),
});

export const suspendEntitySchema = z.strictObject({
  comment: z.string().trim().min(10, 'explain the reason (10+ characters)').max(2_000),
  /** Also stop serving the entity's APIs to other entities (an explicit decision). */
  alsoAsProvider: z.boolean().default(false),
});
/** The entity's X-Road member (M4-05, SPIKE S-5); null takes it out of X-Road. */
export const setXroadMemberSchema = z.strictObject({ member: xroadMemberSchema.nullable() });

export const reactivateEntitySchema = z.strictObject({
  comment: z.string().trim().max(2_000).optional(),
});
export const offboardEntitySchema = z.strictObject({
  comment: z.string().trim().min(10, 'explain the reason (10+ characters)').max(2_000),
});
/**
 * Direct registration by the operator (SPEC.md §4.1 step 1): the same data as a request, plus
 * the person who will administer the entity and the act or decision that grounds it, which
 * stands in for the designation document.
 */
export const createEntitySchema = entityRequestInputSchema.extend({
  admin: designeeInputSchema,
  basis: z.string().trim().min(10, 'reference the act or decision (10+ characters)').max(500),
});
export type CreateEntityInput = z.input<typeof createEntitySchema>;

/** Platform routes name the entity `:id`: `:entityId` is for routes scoped by membership. */
export const adminEntityParamsSchema = z.strictObject({ id: z.uuid() });
