import { z } from 'zod';

/** Objects with a timeline (M1-11). An API's timeline includes its versions. */
export const timelineKindSchema = z.enum(['subscription', 'api']);
export type TimelineKind = z.infer<typeof timelineKindSchema>;

/**
 * One audit event as people read it: who, when, what changed. The full before/after snapshots
 * stay in the database (and in the export, M2-09); the timeline only shows the status change
 * and the comment.
 */
export const auditItemSchema = z.object({
  /** Position in the hash chain (a bigint, as a string). */
  seq: z.string(),
  occurredAt: z.iso.datetime(),
  action: z.string(),
  actor: z.object({
    type: z.enum(['user', 'system', 'application']),
    /** Name of the person, when the viewer may see it; null otherwise. */
    name: z.string().nullable(),
    entity: z.object({ slug: z.string(), shortName: z.string() }).nullable(),
    /** System component (e.g. opa) for system actors. */
    system: z.string().nullable(),
  }),
  target: z.object({ type: z.string(), id: z.string() }),
  status: z.object({ from: z.string().nullable(), to: z.string().nullable() }).nullable(),
  comment: z.string().nullable(),
  hash: z.string().nullable(),
});
export type AuditItem = z.infer<typeof auditItemSchema>;

export const timelineSchema = z.object({ items: z.array(auditItemSchema) });
export type Timeline = z.infer<typeof timelineSchema>;

export const auditEventPageSchema = z.object({
  items: z.array(auditItemSchema),
  nextCursor: z.string().nullable(),
});

/** Filters of the network audit trail and of its export (M2-09). All optional, combined with AND. */
export const auditFiltersShape = {
  /** Exact action (`subscription.approved`) or a whole area (`subscription`). */
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]+)?$/)
    .optional(),
  targetType: z
    .string()
    .regex(/^[a-z_]+$/)
    .optional(),
  targetId: z.string().min(1).max(100).optional(),
  /** Entity on whose behalf the actor acted. */
  entityId: z.uuid().optional(),
  /** Keycloak sub of a person, application id or system component. */
  actorId: z.string().min(1).max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};

export const auditEventsQuerySchema = z.strictObject({
  /** seq of the last item of the previous page (events are listed newest first). */
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  ...auditFiltersShape,
});
export type AuditFilters = {
  [K in keyof typeof auditFiltersShape]?: string;
};

/** Signed export of the audit trail (SPEC.md §6, M2-09). */
export const auditExportQuerySchema = z.strictObject({
  format: z.enum(['csv', 'json']).default('csv'),
  ...auditFiltersShape,
});
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;
export type AuditEventsQuery = z.infer<typeof auditEventsQuerySchema>;

export const timelineParamsSchema = z.strictObject({ kind: timelineKindSchema, id: z.uuid() });
export const entityTimelineParamsSchema = timelineParamsSchema.extend({ entityId: z.uuid() });

/** Result of verifying the whole hash chain. */
export const chainCheckSchema = z.object({
  valid: z.boolean(),
  verified: z.number().int(),
  /** Events written before the chain existed; they cannot be verified. */
  unchained: z.number().int(),
  firstSeq: z.string().nullable(),
  lastSeq: z.string().nullable(),
  lastHash: z.string().nullable(),
  brokenAt: z
    .object({
      seq: z.string(),
      reason: z.enum([
        'gap',
        'prev_hash_mismatch',
        'hash_mismatch',
        'missing_hash',
        'invalid_seq',
        'time_regression',
        'future_dated',
      ]),
    })
    .optional(),
  /**
   * Daily anchors (M2-09): each must still find its last event with the same hash, so that
   * deleting the tail of the chain is detected.
   */
  anchors: z.object({
    checked: z.number().int(),
    lastDay: z.string().nullable(),
    /**
     * Whether the RFC 3161 token of each anchor was verified against the pinned TSA roots (B-02).
     * False when the roots were unavailable: the check is then not valid, it is incomplete.
     */
    timestampsChecked: z.boolean(),
    problems: z.array(
      z.object({
        day: z.string(),
        reason: z.enum(['event_missing', 'hash_mismatch', 'timestamp_invalid', 'future_dated']),
      }),
    ),
  }),
  checkedAt: z.iso.datetime(),
});
export type ChainCheckResult = z.infer<typeof chainCheckSchema>;
