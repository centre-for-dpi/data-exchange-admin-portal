import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  CompactSign,
  compactVerify,
  createLocalJWKSet,
  type CryptoKey,
  type JSONWebKeySet,
  type KeyObject,
} from 'jose';
import { canonicalJson } from './canonical.js';
import { toHex } from './merkle.js';

/**
 * A checkpoint seals one batch of the register (ADR-0016): the root of the batch's Merkle tree,
 * its size, and the hash of the previous checkpoint, so the batches form a chain. The operator
 * signs it (JWS, EdDSA) and a TSA stamps the signed form (RFC 3161).
 */
export interface CheckpointPayload {
  /** Format: 2 for leaves over a LeafEntry (record.ts); 1 for the first batches. */
  v: 1 | 2;
  /** Identifies the register (one per deployment). */
  log: string;
  /** 1, 2, 3… with no gaps. */
  seq: number;
  treeSize: number;
  /** Merkle root of the batch, lowercase hex. */
  root: string;
  /** checkpointHash of seq - 1; null for the first. */
  prev: string | null;
  /** ISO 8601, UTC, when the operator sealed the batch. */
  sealedAt: string;
}

export const CHECKPOINT_JWS_TYPE = 'rid-checkpoint+jws';

/** Hash that links a checkpoint to the next one: SHA-256 of its canonical JSON. */
export const checkpointHash = (payload: CheckpointPayload): string =>
  toHex(sha256(utf8ToBytes(canonicalJson(payload))));

export async function signCheckpoint(
  payload: CheckpointPayload,
  key: CryptoKey | KeyObject,
  kid: string,
): Promise<string> {
  return new CompactSign(utf8ToBytes(canonicalJson(payload)))
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: CHECKPOINT_JWS_TYPE })
    .sign(key);
}

export class CheckpointError extends Error {
  override name = 'CheckpointError';
}

/**
 * Verifies the operator's signature against its public keys (JWKS, by kid) and returns the
 * payload. The payload must be in canonical form, so there is only one valid encoding of it.
 */
export async function verifyCheckpoint(
  jws: string,
  jwks: JSONWebKeySet,
): Promise<CheckpointPayload> {
  let verified: Awaited<ReturnType<typeof compactVerify>>;
  try {
    verified = await compactVerify(jws, createLocalJWKSet(jwks), { algorithms: ['EdDSA'] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CheckpointError(`The operator signature does not verify: ${message}`);
  }
  if (verified.protectedHeader.typ !== CHECKPOINT_JWS_TYPE) {
    throw new CheckpointError('Not a checkpoint of the register');
  }
  const text = new TextDecoder().decode(verified.payload);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CheckpointError('The checkpoint is not JSON');
  }
  if (!isCheckpointPayload(payload) || canonicalJson(payload) !== text) {
    throw new CheckpointError('The checkpoint is malformed');
  }
  return payload;
}

const HEX_64 = /^[0-9a-f]{64}$/;

function isCheckpointPayload(value: unknown): value is CheckpointPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(',');
  return (
    keys === 'log,prev,root,sealedAt,seq,treeSize,v' &&
    (p.v === 1 || p.v === 2) &&
    typeof p.log === 'string' &&
    p.log.length > 0 &&
    Number.isSafeInteger(p.seq) &&
    (p.seq as number) >= 1 &&
    Number.isSafeInteger(p.treeSize) &&
    (p.treeSize as number) >= 1 &&
    typeof p.root === 'string' &&
    HEX_64.test(p.root) &&
    (p.prev === null || (typeof p.prev === 'string' && HEX_64.test(p.prev))) &&
    (p.seq === 1) === (p.prev === null) &&
    typeof p.sealedAt === 'string' &&
    !Number.isNaN(Date.parse(p.sealedAt))
  );
}
