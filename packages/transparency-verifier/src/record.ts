import { canonicalJson } from './canonical.js';
import { leafHash } from './merkle.js';

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

/** The bytes a leaf hashes: canonical JSON of the record. */
export const recordLeafData = (record: AccessRecord): string => canonicalJson(record);

export const recordLeafHash = (record: AccessRecord): Uint8Array =>
  leafHash(recordLeafData(record));
