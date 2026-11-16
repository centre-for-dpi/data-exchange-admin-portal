import { z } from 'zod';
import { ValidationMessage } from './validation-messages.js';

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
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, ValidationMessage.node_name_format),
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
  /** Health the node reported in its last heartbeat. */
  health: z
    .object({
      status: z.enum(['ok', 'degraded', 'failing']),
      detail: z.string().optional(),
      checkedAt: z.iso.datetime(),
    })
    .nullable(),
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

/** Takes a node out of the network: its certificate and tunnel stop working (M4-02). */
export const decommissionNodeSchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
});

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

// ---------------------------------------------------------------------------------------------
// Contract with the kit (ARCHITECTURE.md §10, ADR-0011, M4-02). Versioned: v1.
// ---------------------------------------------------------------------------------------------

/** Version of the contract between the portal and the kit. */
export const NODE_CONTRACT_VERSION = '1';

/**
 * Common name of every node CSR. The kit does not know its node id before enrolling: the CA adds
 * the node's own name (`rid-node-<nodeId>`) as the certificate's only DNS name.
 */
export const NODE_CSR_COMMON_NAME = 'rid-node';

/** DNS name on a node's certificate: what the gateway verifies when it calls the node. */
export const nodeDnsName = (nodeId: string): string => `rid-node-${nodeId}`;

/** A WireGuard public key: 32 bytes, base64 (44 characters). */
export const wireguardKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/, ValidationMessage.wireguard_key);

const kitVersionSchema = z
  .string()
  .max(40)
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, ValidationMessage.semantic_version);

const servicePortSchema = z.number().int().min(1).max(65_535);

/** POST /nodes/enroll: the kit enrolls once with its token (SPEC.md §4.6 step 2). */
export const enrollNodeSchema = z.strictObject({
  token: z.string().min(20).max(200),
  /** PKCS#10, PEM, with CN=rid-node and no other names. The private key never leaves the node. */
  csr: z.string().min(100).max(10_000),
  wireguardPublicKey: wireguardKeySchema,
  kitVersion: kitVersionSchema,
  /** Port of the node's HTTPS listener on its tunnel address. */
  servicePort: servicePortSchema.default(8443),
});
export type EnrollNodeInput = z.input<typeof enrollNodeSchema>;

export const nodeWireguardConfigSchema = z.object({
  /** Interface address of the node, CIDR (/32). */
  address: z.string(),
  hubPublicKey: wireguardKeySchema,
  /** Where the node reaches the hub, host:port (UDP). */
  hubEndpoint: z.string(),
  /** The hub's address inside the tunnel: the only peer address the node routes. */
  hubAddress: z.string(),
  allowedIps: z.array(z.string()),
  persistentKeepaliveSeconds: z.number().int(),
});

export const nodeEnrollmentSchema = z.object({
  contractVersion: z.literal(NODE_CONTRACT_VERSION),
  nodeId: z.uuid(),
  /** DNS name on the certificate; the gateway calls the node with it as SNI and Host. */
  nodeName: z.string(),
  /** The node's certificate followed by its issuing chain, PEM. */
  certificate: z.string(),
  certificateNotAfter: z.iso.datetime(),
  /** Root of the network CA, PEM: the node verifies the gateway and the portal with it. */
  caCertificate: z.string(),
  /** Base URL of the control channel (mTLS with the node's certificate). */
  controlUrl: z.url(),
  /**
   * Common name of the client certificate the gateway presents when it calls the node (one per
   * provider entity, M3-03): the node accepts only that one, from the network CA.
   */
  gatewayClientName: z.string(),
  heartbeatIntervalSeconds: z.number().int(),
  wireguard: nodeWireguardConfigSchema,
});
export type NodeEnrollment = z.infer<typeof nodeEnrollmentSchema>;

export const nodeHealthSchema = z.strictObject({
  status: z.enum(['ok', 'degraded', 'failing']),
  /** Short machine-readable reason, never data of the services. */
  detail: z.string().max(200).optional(),
});

/** POST /nodes/{id}/heartbeat, every heartbeatIntervalSeconds (SPEC.md §4.6 step 3). */
export const nodeHeartbeatSchema = z.strictObject({
  kitVersion: kitVersionSchema,
  servicePort: servicePortSchema,
  services: z.array(nodeServiceSchema).max(100),
  health: nodeHealthSchema,
});
export type NodeHeartbeatInput = z.input<typeof nodeHeartbeatSchema>;

export const nodeHeartbeatResponseSchema = z.object({
  status: nodeStatusSchema,
  nextHeartbeatSeconds: z.number().int(),
  /** The certificate is in the last third of its life: call /renew. */
  renewCertificate: z.boolean(),
});

/** POST /nodes/{id}/renew: a new certificate for a new key (same CSR rules as enrollment). */
export const renewNodeCertificateSchema = z.strictObject({
  csr: z.string().min(100).max(10_000),
});
export const renewedNodeCertificateSchema = z.object({
  certificate: z.string(),
  certificateNotAfter: z.iso.datetime(),
  /** Until when the previous certificate still opens the control channel. */
  previousValidUntil: z.iso.datetime(),
});

/** GET /nodes/{id}/config: what the network expects from the node. */
export const nodeConfigSchema = z.object({
  contractVersion: z.literal(NODE_CONTRACT_VERSION),
  nodeId: z.uuid(),
  heartbeatIntervalSeconds: z.number().int(),
  /** Oldest kit version the network accepts; null when there is no minimum. */
  minimumKitVersion: z.string().nullable(),
  /** Published API versions served by this node: the gateway calls `servicePath` on it. */
  services: z.array(
    z.object({
      apiVersionId: z.uuid(),
      apiName: z.string(),
      version: z.string(),
      /** Public base path at the gateway. */
      basePath: z.string(),
      servicePath: z.string(),
    }),
  ),
  notices: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type NodeConfig = z.infer<typeof nodeConfigSchema>;

export const nodeControlParamsSchema = z.object({ nodeId: z.uuid() });
