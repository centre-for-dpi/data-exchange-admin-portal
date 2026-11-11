import { z } from 'zod';
import { entityRoleSchema, platformRoleSchema } from './roles.js';

/** Cursor pagination (CLAUDE.md conventions): `?cursor=&limit=`. */
export const paginationQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    /** Pass as `cursor` to get the next page; null when there are no more items. */
    nextCursor: z.uuid().nullable(),
  });

export const membershipSummarySchema = z.object({
  entity: z.object({
    id: z.uuid(),
    slug: z.string(),
    shortName: z.string(),
  }),
  roles: z.array(entityRoleSchema),
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

/** GET /api/v1/me: who the caller is, re-evaluated on every request (ADR-0004). */
export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
  }),
  platformRoles: z.array(platformRoleSchema),
  /** Active memberships only. */
  memberships: z.array(membershipSummarySchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const entitySummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  legalName: z.string(),
  shortName: z.string(),
  kind: z.enum(['national', 'territorial', 'autonomous', 'private_authorized']),
  sector: z.string(),
  status: z.enum(['requested', 'under_review', 'active', 'rejected', 'suspended', 'offboarded']),
  contactEmail: z.string(),
  website: z.string().nullable(),
});
export type EntitySummary = z.infer<typeof entitySummarySchema>;

export const entityMemberSchema = z.object({
  membershipId: z.uuid(),
  user: z.object({ id: z.uuid(), fullName: z.string(), email: z.string() }),
  roles: z.array(entityRoleSchema),
  status: z.enum(['invited', 'active', 'revoked']),
});
export type EntityMember = z.infer<typeof entityMemberSchema>;

export const entityMembersPageSchema = pageOf(entityMemberSchema);

export const entityIdParamsSchema = z.strictObject({ entityId: z.uuid() });
