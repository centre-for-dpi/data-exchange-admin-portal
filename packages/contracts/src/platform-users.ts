import { z } from 'zod';
import { emailSchema } from './entities.js';
import { platformRoleSchema } from './roles.js';
import { ValidationMessage } from './validation-messages.js';

/**
 * Operator console: who holds platform roles, and disabling a user (M-03). Every change is
 * audited with the reason the operator gives.
 */
const reasonSchema = z.string().trim().min(10, ValidationMessage.explain_reason).max(2_000);

/** The user's account status in the portal (`disabled`: every API request answers 403). */
export const userStatusSchema = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const platformRoleHolderSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  status: userStatusSchema,
  role: platformRoleSchema,
  /** The actor that granted it: a user's `sub`, or `cli:platform-roles`, or `seed`. */
  grantedBy: z.string(),
  grantedAt: z.iso.datetime(),
});
export type PlatformRoleHolder = z.infer<typeof platformRoleHolderSchema>;

export const platformRoleHolderListSchema = z.object({
  items: z.array(platformRoleHolderSchema),
});

/** Grants or revokes one platform role of the person with that e-mail address. */
export const platformRoleChangeSchema = z.strictObject({
  email: emailSchema,
  role: platformRoleSchema,
  reason: reasonSchema,
});
export type PlatformRoleChangeInput = z.output<typeof platformRoleChangeSchema>;

export const platformRoleResultSchema = z.object({
  outcome: z.enum(['granted', 'revoked', 'unchanged']),
  email: z.string(),
  role: platformRoleSchema,
});

/** Disables or enables the account with that e-mail address. */
export const userStatusChangeSchema = z.strictObject({
  email: emailSchema,
  reason: reasonSchema,
});
export type UserStatusChangeInput = z.output<typeof userStatusChangeSchema>;

export const userStatusResultSchema = z.object({
  outcome: z.enum(['disabled', 'enabled', 'unchanged']),
  email: z.string(),
  status: userStatusSchema,
});
