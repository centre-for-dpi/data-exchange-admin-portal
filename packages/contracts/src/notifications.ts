import { z } from 'zod';

/**
 * Notification kinds (SPEC.md §7, M2-08).
 * - `security`: the e-mail cannot be turned off (access taken away).
 * - `email: false`: in the portal only, because the event already sends its own e-mail (the
 *   invitation goes to an address that may not have an account yet).
 */
export const NOTIFICATION_KINDS = {
  invitation_received: { security: false, email: false },
  entity_request_decided: { security: false, email: true },
  entity_status_changed: { security: true, email: true },
  api_review_requested: { security: false, email: true },
  api_changes_requested: { security: false, email: true },
  api_published: { security: false, email: true },
  api_deprecated: { security: false, email: true },
  regulator_approval_needed: { security: false, email: true },
  access_requested: { security: false, email: true },
  access_request_answered: { security: false, email: true },
  access_info_requested: { security: false, email: true },
  access_approved: { security: false, email: true },
  access_rejected: { security: false, email: true },
  access_expiring: { security: false, email: true },
  access_suspended: { security: true, email: true },
  access_revoked: { security: true, email: true },
  certificate_expiring: { security: false, email: true },
  node_offline: { security: false, email: true },
} as const satisfies Record<string, { security: boolean; email: boolean }>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
export const notificationKindSchema = z.enum(
  Object.keys(NOTIFICATION_KINDS) as [NotificationKind, ...NotificationKind[]],
);

/** Values a notification text may use; all optional, depending on the kind. */
export const notificationParamsSchema = z.object({
  entity: z.string().optional(),
  api: z.string().optional(),
  version: z.string().optional(),
  application: z.string().optional(),
  node: z.string().optional(),
  decision: z.string().optional(),
  what: z.enum(['api', 'subscription']).optional(),
  date: z.iso.datetime().optional(),
});
export type NotificationParams = z.infer<typeof notificationParamsSchema>;

export const notificationSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  params: notificationParamsSchema,
  /** Portal path to open (without locale prefix). */
  link: z.string(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.uuid().nullable(),
  unread: z.number().int(),
});

export const notificationListQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  unread: z.enum(['true', 'false']).optional(),
});

export const notificationIdParamsSchema = z.strictObject({ notificationId: z.uuid() });

export const notificationPreferenceSchema = z.object({
  kind: notificationKindSchema,
  email: z.boolean(),
  /** The e-mail cannot be turned off (security), or the kind has no e-mail of its own. */
  locked: z.boolean(),
});
export const notificationPreferencesSchema = z.object({
  items: z.array(notificationPreferenceSchema),
});
export const updateNotificationPreferencesSchema = z.strictObject({
  items: z
    .array(z.strictObject({ kind: notificationKindSchema, email: z.boolean() }))
    .min(1)
    .max(50),
});
