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
  /** A leaf row no longer matches what the signed root commits to (format 2). */
  'leaf_altered',
  /** Anchored in the audit chain but absent: batches were removed. */
  'checkpoint_missing',
  /** A checkpoint the audit chain does not know: inserted outside the sealer. */
  'anchor_missing',
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

/** Text from the country config or the database: a string or { es, en }. */
const localizedSchema = z.union([z.string(), z.record(z.string(), z.string())]);

/**
 * One consultation of the citizen's data, as the citizen sees it in the Carpeta (ADR-0015, SPEC
 * §2.4): who consulted, when, which data, for what purpose and with which official (as an opaque
 * reference). Never the document number.
 */
export const subjectAccessItemSchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  consumer: z.object({
    entity: z.object({ name: z.string(), shortName: z.string() }).nullable(),
    application: z.string().nullable(),
  }),
  provider: z.object({ name: z.string(), shortName: z.string() }).nullable(),
  api: z.object({ name: z.string(), version: z.string() }).nullable(),
  operation: z.object({ id: z.string(), summary: z.string().nullable() }),
  purpose: z.object({ code: z.string(), name: localizedSchema.nullable() }),
  /** What the API exposes, as declared when it was published. */
  data: z.array(z.object({ name: z.string(), personal: z.boolean(), sensitive: z.boolean() })),
  /** Keyed hash of the official behind the call; lets the citizen ask about it in a complaint. */
  officialRef: z.string().nullable(),
  /** HTTP status the consumer got (404: the provider had nothing about the citizen). */
  status: z.number().int(),
  /** Whether it is already in a sealed batch: only then a receipt can be downloaded. */
  sealed: z.boolean(),
});
export type SubjectAccessItem = z.infer<typeof subjectAccessItemSchema>;

export const subjectAccessPageSchema = z.object({
  items: z.array(subjectAccessItemSchema),
  nextCursor: z.string().nullable(),
});
export type SubjectAccessPage = z.infer<typeof subjectAccessPageSchema>;

export const subjectAccessesQuerySchema = z.strictObject({
  /** Opaque: from nextCursor of the previous page (consultations are listed newest first). */
  cursor: z
    .string()
    .regex(/^\d{1,15}_[0-9a-f-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SubjectAccessesQuery = z.infer<typeof subjectAccessesQuerySchema>;
