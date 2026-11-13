import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { JSONWebKeySet } from 'jose';
import { CheckpointError, type CheckpointPayload, verifyCheckpoint } from './checkpoint.js';
import { fromHex, verifyInclusion } from './merkle.js';
import { type AccessRecord, recordLeafHash } from './record.js';
import { TimestampError, verifyTimestampToken } from './tsa.js';

/**
 * Receipt of one call (ADR-0016 §4): the record, where it sits in its batch, the batch's signed
 * checkpoint and the TSA's time-stamp over that signed checkpoint. Everything needed to check it
 * is inside, plus two public inputs the verifier chooses to trust: the operator's JWKS and the
 * TSA's root certificate.
 */
export interface Receipt {
  v: 1;
  record: AccessRecord;
  leafIndex: number;
  /** Audit path of RFC 9162, bottom to top, lowercase hex. */
  proof: string[];
  /** Compact JWS of the checkpoint, signed by the operator. */
  checkpoint: string;
  /** RFC 3161 time-stamp token over the JWS bytes, base64 (DER). Absent while pending. */
  timestamp: string | null;
}

/**
 * How far ahead of the time-stamp a record may be dated: the gateway and the TSA keep their own
 * clocks, and genTime is often rounded to the second. A call dated well after the stamp of its
 * own batch cannot be genuine.
 */
export const CLOCK_SKEW_MS = 60_000;

export interface VerifyOptions {
  jwks: JSONWebKeySet;
  /** PEM certificates of the TSA roots the verifier trusts. */
  tsaRoots: readonly string[];
  /** Accept a receipt whose batch is not stamped yet (the time is then the operator's word). */
  allowPendingTimestamp?: boolean;
}

export interface ReceiptVerification {
  valid: boolean;
  checks: {
    signature: boolean;
    inclusion: boolean;
    timestamp: 'valid' | 'pending' | 'invalid';
  };
  checkpoint?: CheckpointPayload;
  /** When the TSA saw the signed checkpoint: the call happened before this. */
  stampedAt?: string;
  errors: string[];
}

export async function verifyReceipt(
  receipt: Receipt,
  options: VerifyOptions,
): Promise<ReceiptVerification> {
  const errors: string[] = [];
  const checks: ReceiptVerification['checks'] = {
    signature: false,
    inclusion: false,
    timestamp: 'invalid',
  };
  if (receipt?.v !== 1) return { valid: false, checks, errors: ['Unknown receipt version'] };

  let checkpoint: CheckpointPayload | undefined;
  try {
    checkpoint = await verifyCheckpoint(receipt.checkpoint, options.jwks);
    checks.signature = true;
  } catch (error) {
    errors.push(error instanceof CheckpointError ? error.message : String(error));
  }

  if (checkpoint) {
    try {
      checks.inclusion = verifyInclusion(
        recordLeafHash(receipt.record),
        receipt.leafIndex,
        checkpoint.treeSize,
        receipt.proof.map(fromHex),
        fromHex(checkpoint.root),
      );
    } catch {
      checks.inclusion = false;
    }
    if (!checks.inclusion) {
      errors.push('The record is not in the signed batch, or it was altered');
    }
  }

  let stampedAt: string | undefined;
  if (receipt.timestamp === null) {
    checks.timestamp = 'pending';
    if (!options.allowPendingTimestamp) errors.push('The batch has no time-stamp yet');
  } else {
    try {
      const stamp = await verifyTimestampToken(
        new Uint8Array(Buffer.from(receipt.timestamp, 'base64')),
        utf8ToBytes(receipt.checkpoint),
        options.tsaRoots,
      );
      checks.timestamp = 'valid';
      stampedAt = stamp.genTime.toISOString();
      const latest = stamp.genTime.getTime() + stamp.accuracyMs + CLOCK_SKEW_MS;
      if (Date.parse(receipt.record.occurredAt) > latest) {
        checks.timestamp = 'invalid';
        errors.push('The record is dated after the time-stamp of its batch');
      }
    } catch (error) {
      errors.push(error instanceof TimestampError ? error.message : String(error));
    }
  }

  const valid =
    checks.signature &&
    checks.inclusion &&
    (checks.timestamp === 'valid' ||
      (checks.timestamp === 'pending' && options.allowPendingTimestamp === true));
  return {
    valid,
    checks,
    ...(checkpoint ? { checkpoint } : {}),
    ...(stampedAt ? { stampedAt } : {}),
    errors,
  };
}
