import { z } from 'zod';
import { ValidationMessage } from './validation-messages.js';

/** Longest period a usage query covers, in days. */
export const USAGE_MAX_DAYS = 366;
/** Period when none is given: the last 30 days, today included. */
export const USAGE_DEFAULT_DAYS = 30;

const isoDate = z.iso.date();
/** Text of the catalogue in each language, or one string (the purposes' names). */
const localizedSchema = z.union([z.string(), z.record(z.string(), z.string())]);

/**
 * Period and filters of a usage query (M5-02, M5-03). Dates are calendar days in the country's
 * time zone, both included. `environment` separates real traffic from the sandbox's (M4-08).
 */
export const usageQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    apiId: z.uuid().optional(),
    environment: z.enum(['production', 'sandbox']).default('production'),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: ValidationMessage.period_reversed,
    path: ['from'],
  });
export type UsageQuery = z.infer<typeof usageQuerySchema>;

/** Calls of a group: all of them, and those answered with an error (4xx or 5xx). */
const countsSchema = z.object({ calls: z.number().int(), errors: z.number().int() });

export const usageTotalsSchema = z.object({
  calls: z.number().int(),
  /** 2xx. */
  ok: z.number().int(),
  /** Refused by the gateway (OPA, rate limit): they never reached the provider. */
  denied: z.number().int(),
  /** Other 4xx: authentication (401) and the provider's own. */
  clientErrors: z.number().int(),
  /** 5xx, from the provider or the gateway. */
  serverErrors: z.number().int(),
  /** Latency the gateway measured, in milliseconds; null without calls. */
  latencyP50Ms: z.number().nullable(),
  latencyP95Ms: z.number().nullable(),
});

export const usagePeriodSchema = z.object({
  from: isoDate,
  to: isoDate,
  timeZone: z.string(),
});

export const usageDaySchema = countsSchema.extend({ date: isoDate });

/** One answer code and how many calls got it. */
export const usageStatusSchema = z.object({ status: z.number().int(), calls: z.number().int() });

export const providerUsageSchema = z.object({
  period: usagePeriodSchema,
  environment: z.enum(['production', 'sandbox']),
  totals: usageTotalsSchema,
  daily: z.array(usageDaySchema),
  /** Consumer entities; `entityId` null when the gateway could not tell who called. */
  byConsumer: z.array(
    countsSchema.extend({
      entityId: z.uuid().nullable(),
      entityName: z.string().nullable(),
    }),
  ),
  byPurpose: z.array(
    z.object({ code: z.string(), name: localizedSchema.nullable(), calls: z.number().int() }),
  ),
  byOperation: z.array(
    countsSchema.extend({
      apiId: z.uuid(),
      apiName: z.string(),
      version: z.string(),
      operation: z.string(),
      latencyP95Ms: z.number().nullable(),
    }),
  ),
  byStatus: z.array(usageStatusSchema),
});
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

/** Period and filter of the usage of an entity's applications (M5-03). */
export const consumedUsageQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    applicationId: z.uuid().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: ValidationMessage.period_reversed,
    path: ['from'],
  });
export type ConsumedUsageQuery = z.infer<typeof consumedUsageQuerySchema>;

/**
 * Calls the entity's applications made (M5-03). Calls with a token the gateway could not tie to
 * an application (401) are not anyone's: they are not here.
 */
export const consumedUsageSchema = z.object({
  period: usagePeriodSchema,
  totals: usageTotalsSchema,
  daily: z.array(usageDaySchema),
  byApplication: z.array(
    countsSchema.extend({
      applicationId: z.uuid(),
      name: z.string(),
      environment: z.enum(['production', 'sandbox']),
      denied: z.number().int(),
    }),
  ),
  /** The APIs called; `apiId` null for a route that is no version's any more. */
  byApi: z.array(
    countsSchema.extend({
      apiId: z.uuid().nullable(),
      apiName: z.string().nullable(),
      version: z.string().nullable(),
      providerName: z.string().nullable(),
      sandbox: z.boolean(),
      latencyP95Ms: z.number().nullable(),
    }),
  ),
  /** Refusals of the gateway by their stable reason (ARCHITECTURE.md §4.2), per application. */
  denials: z.array(
    z.object({
      reason: z.string(),
      applicationId: z.uuid(),
      name: z.string(),
      calls: z.number().int(),
    }),
  ),
});
export type ConsumedUsage = z.infer<typeof consumedUsageSchema>;
