import { z } from 'zod';

/**
 * Bootcamp readiness (M4-07): what an entity has ready before its node is installed. `designees`
 * is derived from the entity's members (a publisher and a data steward); the others are confirmed
 * by the entity's admin or the operator.
 */
export const BOOTCAMP_ITEMS = [
  'server',
  'readonly_user',
  'outbound_443',
  'designees',
  'use_case',
] as const;
export const bootcampItemSchema = z.enum(BOOTCAMP_ITEMS);
export type BootcampItem = z.infer<typeof bootcampItemSchema>;
/** The items someone confirms by hand. */
export const manualBootcampItemSchema = z.enum([
  'server',
  'readonly_user',
  'outbound_443',
  'use_case',
]);

export const bootcampItemParamsSchema = z.object({
  entityId: z.uuid(),
  item: manualBootcampItemSchema,
});

export const updateBootcampItemSchema = z.strictObject({
  status: z.enum(['pending', 'done']),
  /** For the operator (server size, the use case). Never a password or credential. */
  note: z.string().trim().max(1_000).optional(),
});

export const bootcampChecklistItemSchema = z.object({
  item: bootcampItemSchema,
  status: z.enum(['pending', 'done']),
  /** Derived from the entity's data, not confirmed by hand. */
  automatic: z.boolean(),
  note: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const bootcampChecklistSchema = z.object({
  items: z.array(bootcampChecklistItemSchema),
  ready: z.boolean(),
});
export type BootcampChecklist = z.infer<typeof bootcampChecklistSchema>;

/** Operator console: every active entity and its readiness. */
export const networkBootcampSchema = z.object({
  items: z.array(
    z.object({
      entity: z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() }),
      checklist: bootcampChecklistSchema,
      done: z.number().int(),
      total: z.number().int(),
    }),
  ),
});
