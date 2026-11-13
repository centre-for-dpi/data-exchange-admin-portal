import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from './canonical.js';
import { leafHash, toHex } from './merkle.js';

/**
 * What a leaf of the transparency register commits to: one call that reached a provider, as the
 * portal stored it (MT-03). Metadata only; the data subject as the gateway's keyed pseudonym.
 * The consumer-chosen X-Request-Id is left out on purpose: it is not evidence of anything and a
 * client could put anything in it.
 */
export interface AccessRecord {
  v: 1;
  id: string;
  /** ISO 8601, UTC, milliseconds. */
  occurredAt: string;
  subjectRef: string;
  subjectSource: 'path' | 'body';
  providerEntityId: string;
  apiId: string;
  apiVersionId: string;
  operationId: string;
  exposedFields: unknown;
  consumerEntityId: string;
  applicationId: string;
  subscriptionId: string;
  purposeCode: string;
  endUserHash: string | null;
  status: number;
  gatewayNode: string;
  gatewayRequestId: string;
}

/**
 * What a leaf commits to: the record's id and time, and a digest of the whole record. The id and
 * the time stay bound to the signed root even after retention purges the record itself, so a
 * verifier can tell a record purged on schedule from one deleted early.
 */
export interface LeafEntry {
  v: 1;
  id: string;
  occurredAt: string;
  /** SHA-256 of the record's canonical JSON, lowercase hex. */
  digest: string;
}

export const recordDigest = (record: AccessRecord): string =>
  toHex(sha256(utf8ToBytes(canonicalJson(record))));

export const leafEntryOf = (record: AccessRecord): LeafEntry => ({
  v: 1,
  id: record.id,
  occurredAt: record.occurredAt,
  digest: recordDigest(record),
});

/** Leaf hash (RFC 9162) of an entry: SHA-256(0x00 ‖ canonical JSON of the entry). */
export const entryLeafHash = (entry: LeafEntry): Uint8Array => leafHash(canonicalJson(entry));

/**
 * Leaf hash of a record in a checkpoint of the given format version. Version 1 (the first sealed
 * batches) hashed the record's canonical JSON directly; version 2 hashes its LeafEntry.
 */
export const recordLeafHash = (record: AccessRecord, version: 1 | 2 = 2): Uint8Array =>
  version === 1 ? leafHash(canonicalJson(record)) : entryLeafHash(leafEntryOf(record));
