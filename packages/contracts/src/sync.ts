import { z } from 'zod';
import { upstreamTypeSchema } from './apis.js';
import { nodeVersionContractSchema } from './nodes.js';

/** Systems the portal reconciles (sync_state.system). */
export const SYNC_SYSTEMS = ['apisix', 'keycloak', 'opa', 'wireguard', 'opensearch'] as const;
export const SYNC_STATUSES = ['pending', 'in_sync', 'drift', 'error'] as const;

/**
 * The operator's sync console (M5-07): objects the reconcilers keep. `problems` lists those not
 * in sync or with drift found in the last day.
 */
export const syncQuerySchema = z.object({
  system: z.enum(SYNC_SYSTEMS).optional(),
  status: z.enum([...SYNC_STATUSES, 'problems']).optional(),
  /** Part of the target, e.g. a version or client id. */
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SyncQuery = z.infer<typeof syncQuerySchema>;

export const syncTargetSchema = z.object({
  target: z.string(),
  system: z.string(),
  status: z.enum(SYNC_STATUSES),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  /** The desired state is applied (same hash). */
  applied: z.boolean(),
  driftDetectedAt: z.iso.datetime().nullable(),
  driftCount: z.number().int(),
});
export type SyncTarget = z.infer<typeof syncTargetSchema>;

/**
 * A version still served with an upstream type the deployment no longer accepts for new versions
 * (P-04): it keeps working until the operator decides.
 */
export const disallowedUpstreamSchema = z.object({
  versionId: z.uuid(),
  version: z.string(),
  status: z.string(),
  apiName: z.string(),
  entityName: z.string(),
  /** The types of its upstream and sandbox upstream that are no longer accepted. */
  types: z.array(upstreamTypeSchema),
});
export type DisallowedUpstream = z.infer<typeof disallowedUpstreamSchema>;

/** A published version whose node does not report its contract (P-02). */
export const nodeContractIssueSchema = nodeVersionContractSchema.extend({
  entityName: z.string(),
  nodeId: z.uuid(),
  nodeName: z.string(),
});
export type NodeContractIssue = z.infer<typeof nodeContractIssueSchema>;

export const syncPageSchema = z.object({
  summary: z.array(
    z.object({
      system: z.string(),
      status: z.enum(SYNC_STATUSES),
      count: z.number().int(),
    }),
  ),
  /** Targets with drift found and repaired in the last 24 hours. */
  recentDrift: z.number().int(),
  items: z.array(syncTargetSchema),
  nextCursor: z.string().nullable(),
  /** Versions not yet retired whose upstream type is no longer accepted (P-04). */
  disallowedUpstreams: z.array(disallowedUpstreamSchema),
  /**
   * Published versions whose node serves another contract (`differs`) or reports none
   * (`not_reported`), differing ones first (P-02).
   */
  nodeContracts: z.array(nodeContractIssueSchema),
});
export type SyncPage = z.infer<typeof syncPageSchema>;

export const retrySyncSchema = z.strictObject({ target: z.string().min(3).max(300) });

export const retrySyncResultSchema = z.object({ queued: z.literal(true), target: z.string() });
