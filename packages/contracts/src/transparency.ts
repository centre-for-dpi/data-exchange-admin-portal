import { z } from 'zod';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A sealed batch of the transparency register (ADR-0016), as published to anyone: hashes only,
 * no personal data. The signed JWS and the RFC 3161 time-stamp let a third party check it with
 * the operator's JWKS and the TSA's certificate.
 */
export const transparencyCheckpointSchema = z.object({
  seq: z.number().int().min(1),
  treeSize: z.number().int().min(1),
  root: hex64,
  prev: hex64.nullable(),
  hash: hex64,
  sealedAt: z.iso.datetime(),
  kid: z.string(),
  /** Compact JWS (EdDSA) of the checkpoint, signed by the operator. */
  jws: z.string(),
  /** RFC 3161 time-stamp token over the JWS, base64 DER; null while pending. */
  timestamp: z
    .object({ token: z.string(), genTime: z.iso.datetime(), serialNumber: z.string() })
    .nullable(),
});
export type TransparencyCheckpoint = z.infer<typeof transparencyCheckpointSchema>;

export const transparencyCheckpointPageSchema = z.object({
  items: z.array(transparencyCheckpointSchema),
  nextCursor: z.string().nullable(),
});

export const transparencyCheckpointsQuerySchema = z.strictObject({
  /** seq of the last item of the previous page (checkpoints are listed oldest first). */
  cursor: z
    .string()
    .regex(/^\d{1,9}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TransparencyCheckpointsQuery = z.infer<typeof transparencyCheckpointsQuerySchema>;

export const transparencyCheckpointParamsSchema = z.strictObject({
  seq: z.coerce.number().int().min(1).max(2_147_483_647),
});

/** Public keys of the operator, current and retired (RFC 7517). */
export const transparencyJwksSchema = z.object({
  keys: z.array(
    z.looseObject({
      kty: z.literal('OKP'),
      crv: z.literal('Ed25519'),
      x: z.string(),
      kid: z.string(),
    }),
  ),
});

/** The record a leaf commits to (packages/transparency-verifier AccessRecord). */
export const accessRecordSchema = z.object({
  v: z.literal(1),
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  subjectRef: hex64,
  subjectSource: z.enum(['path', 'body']),
  providerEntityId: z.uuid(),
  apiId: z.uuid(),
  apiVersionId: z.uuid(),
  operationId: z.string(),
  exposedFields: z.unknown(),
  consumerEntityId: z.uuid(),
  applicationId: z.uuid(),
  subscriptionId: z.uuid(),
  purposeCode: z.string(),
  endUserHash: hex64.nullable(),
  status: z.number().int(),
  gatewayNode: z.string(),
  gatewayRequestId: z.string(),
});

/** Receipt of one call: verifiable offline with rid-verify-receipt (ADR-0016 §4). */
export const transparencyReceiptSchema = z.object({
  v: z.literal(1),
  record: accessRecordSchema,
  leafIndex: z.number().int().min(0),
  proof: z.array(hex64),
  checkpoint: z.string(),
  timestamp: z.string().nullable(),
});
export type TransparencyReceipt = z.infer<typeof transparencyReceiptSchema>;

export const transparencyProblemKindSchema = z.enum([
  'chain_broken',
  'signature_invalid',
  'root_mismatch',
  'record_altered',
  'record_deleted',
  'timestamp_invalid',
]);

/** Result of re-checking the whole register: batches, chain, signatures, stamps and records. */
export const transparencyVerificationSchema = z.object({
  valid: z.boolean(),
  checkpoints: z.number().int(),
  records: z.number().int(),
  /** Records purged by retention: their leaves remain, so the batches still verify. */
  purged: z.number().int(),
  /** Records not sealed yet. */
  unsealed: z.number().int(),
  /** Checkpoints still waiting for the TSA. */
  pendingTimestamps: z.number().int(),
  /** False when the TSA certificates could not be fetched: the stamps were not checked. */
  timestampsChecked: z.boolean(),
  problems: z.array(
    z.object({
      kind: transparencyProblemKindSchema,
      seq: z.number().int(),
      recordId: z.uuid().nullable(),
    }),
  ),
});
export type TransparencyVerification = z.infer<typeof transparencyVerificationSchema>;
