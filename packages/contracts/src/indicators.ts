import { z } from 'zod';

const isoDate = z.iso.date();

/** Period of the network's indicators (M5-04): calendar days in the country's time zone. */
export const indicatorsQuerySchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });
export type IndicatorsQuery = z.infer<typeof indicatorsQuerySchema>;

/**
 * The network's indicators (SPEC.md §8, M5-04), for the regulator and the operator. Calls count
 * production traffic only: the sandbox and the gateway's validation checks are left out.
 */
export const networkIndicatorsSchema = z.object({
  period: z.object({ from: isoDate, to: isoDate, timeZone: z.string() }),
  /** % of 2xx over the calls, without the authorization refusals (401/403), reported apart. */
  successfulCalls: z.object({
    calls: z.number().int(),
    ok: z.number().int(),
    /** 401 and 403: authentication and the gateway's authorization. */
    authorizationRefused: z.number().int(),
    /** ok / (calls − authorizationRefused); null without calls. */
    rate: z.number().nullable(),
    refusedByReason: z.array(z.object({ reason: z.string(), calls: z.number().int() })),
  }),
  /** Published APIs with at least one successful production call in the period. */
  apisInUse: z.object({
    published: z.number().int(),
    inUse: z.number().int(),
    items: z.array(
      z.object({
        apiId: z.uuid(),
        apiName: z.string(),
        providerName: z.string(),
        calls: z.number().int(),
      }),
    ),
  }),
  /**
   * Days from an entity's start (its node's enrollment, or its onboarding when it has no node)
   * to the first successful production call to one of its APIs; null while there is none.
   */
  timeToFirstUse: z.object({
    medianDays: z.number().nullable(),
    entities: z.array(
      z.object({
        entityId: z.uuid(),
        name: z.string(),
        since: z.iso.datetime(),
        sinceKind: z.enum(['node', 'entity']),
        firstCallAt: z.iso.datetime().nullable(),
        days: z.number().nullable(),
      }),
    ),
  }),
  /** Entities with at least one published API, by month of their first publication. */
  connectedEntities: z.object({
    total: z.number().int(),
    byMonth: z.array(
      z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        count: z.number().int(),
        cumulative: z.number().int(),
      }),
    ),
  }),
  /** Median hours from an access request to the provider's decision, decisions in the period. */
  approvalTime: z.object({ medianHours: z.number().nullable(), decisions: z.number().int() }),
  /** % of time the gateway answered its health check (Prometheus); null without data. */
  gatewayAvailability: z.object({ percent: z.number().nullable() }),
  /** Manual steps the use cases avoid, as the entities captured them (bootcamp use case). */
  manualStepsAvoided: z.object({ total: z.number().int(), useCases: z.number().int() }),
});
export type NetworkIndicators = z.infer<typeof networkIndicatorsSchema>;

/**
 * Who exchanges data with whom (M5-05): consumer entity → provider entity, with the volume of
 * production calls in the period and the active subscriptions between them (an agreed exchange
 * may have no calls yet).
 */
export const exchangeMapSchema = z.object({
  period: z.object({ from: isoDate, to: isoDate, timeZone: z.string() }),
  exchanges: z.array(
    z.object({
      consumerId: z.uuid(),
      consumerName: z.string(),
      providerId: z.uuid(),
      providerName: z.string(),
      calls: z.number().int(),
      errors: z.number().int(),
      activeSubscriptions: z.number().int(),
    }),
  ),
});
export type ExchangeMap = z.infer<typeof exchangeMapSchema>;
