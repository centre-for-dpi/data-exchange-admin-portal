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

export const auditEventsQuerySchema = z.strictObject({
  /** seq of the last item of the previous page (events are listed newest first). */
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
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
      reason: z.enum(['gap', 'prev_hash_mismatch', 'hash_mismatch', 'missing_hash']),
    })
    .optional(),
  checkedAt: z.iso.datetime(),
});
export type ChainCheckResult = z.infer<typeof chainCheckSchema>;
