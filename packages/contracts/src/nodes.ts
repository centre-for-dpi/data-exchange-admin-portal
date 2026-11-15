import { z } from 'zod';

/** SPEC.md §4.6 */
export const NODE_STATUSES = [
  'enrollment_issued',
  'enrolled',
  'online',
  'offline',
  'decommissioned',
] as const;
export const nodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const nodeIdParamsSchema = z.object({ entityId: z.uuid(), nodeId: z.uuid() });
export const enrollmentTokenParamsSchema = z.object({
  entityId: z.uuid(),
  nodeId: z.uuid(),
  tokenId: z.uuid(),
});

/** A node and its first enrollment token (M4-01). */
export const createNodeSchema = z.strictObject({
  /** Unique per entity, e.g. "servidor-principal". */
  name: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, 'letters, digits, spaces, dots, dashes'),
});
export type CreateNodeInput = z.input<typeof createNodeSchema>;

/**
 * An enrollment token as listed (never the token itself). `expired` is an active token past its
 * expiry: it no longer enrolls anything.
 */
export const enrollmentTokenSchema = z.object({
  id: z.uuid(),
  status: z.enum(['active', 'used', 'revoked', 'expired']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  usedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type EnrollmentToken = z.infer<typeof enrollmentTokenSchema>;

/** A service a node declares in its heartbeat (ARCHITECTURE.md §10, M4-02). */
export const nodeServiceSchema = z.strictObject({
  /** Stable name of the service on the node, e.g. "afiliacion". */
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Base path of the service on the node, e.g. /salud. */
  path: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9._~\-/]*$/),
  /** SHA-256 (hex) of the OpenAPI document the service implements. */
  openapiSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type NodeService = z.infer<typeof nodeServiceSchema>;

export const nodeSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: nodeStatusSchema,
  kitVersion: z.string().nullable(),
  tunnelAddress: z.string().nullable(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  enrolledAt: z.iso.datetime().nullable(),
  certificateNotAfter: z.iso.datetime().nullable(),
  services: z.array(nodeServiceSchema),
  createdAt: z.iso.datetime(),
  /** Most recent enrollment token, if any. */
  enrollmentToken: enrollmentTokenSchema.nullable(),
});
export type NodeSummary = z.infer<typeof nodeSummarySchema>;

export const nodeListSchema = z.object({ items: z.array(nodeSummarySchema) });

export const nodeDetailSchema = nodeSummarySchema.extend({
  enrollmentTokens: z.array(enrollmentTokenSchema),
});
export type NodeDetail = z.infer<typeof nodeDetailSchema>;

/** Response to issuing a token: the token is shown here once and never again. */
export const issuedEnrollmentTokenSchema = z.object({
  node: nodeSummarySchema,
  token: z.string(),
  expiresAt: z.iso.datetime(),
});
export type IssuedEnrollmentToken = z.infer<typeof issuedEnrollmentTokenSchema>;

/** Operator console (SPEC.md §6): every node of the network with its entity. */
export const networkNodeSchema = nodeSummarySchema.extend({
  entity: z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() }),
});
export type NetworkNode = z.infer<typeof networkNodeSchema>;
export const networkNodeListSchema = z.object({ items: z.array(networkNodeSchema) });
