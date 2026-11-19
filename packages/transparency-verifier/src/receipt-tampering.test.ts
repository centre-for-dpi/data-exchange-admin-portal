// Tampering cases beyond receipt.test.ts (from the 2026-11 general review, docs/reviews/2026-11-general-review.md §8).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CryptoKey, importJWK, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { signCheckpoint, verifyCheckpoint } from './checkpoint.js';
import { inclusionProof, nodeHash, toHex, treeRoot } from './merkle.js';
import { type Receipt, verifyReceipt } from './receipt.js';
import { type AccessRecord, recordLeafHash } from './record.js';
import { certificatesInPem } from './tsa.js';

interface Fixture {
  privateJwk: JWK & { kid: string };
  records: AccessRecord[];
  checkpoint: string;
  timestamp: string;
  tsaRoot: string;
}
const load = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `__fixtures__/${name}`), 'utf8')) as Fixture;
const fixture = load('receipt-fixture.json');
const v1 = load('receipt-fixture-v1.json');
const { d: _d, ...publicJwk } = fixture.privateJwk;
const jwks = { keys: [publicJwk] };
const tsaRoots = certificatesInPem(fixture.tsaRoot);
const leaves = fixture.records.map((r) => recordLeafHash(r));
const receiptFor = (index: number): Receipt => ({
  v: 1,
  record: fixture.records[index] as AccessRecord,
  leafIndex: index,
  proof: inclusionProof(leaves, index).map(toHex),
  checkpoint: fixture.checkpoint,
  timestamp: fixture.timestamp,
});
const verify = (receipt: unknown) => verifyReceipt(receipt as Receipt, { jwks, tsaRoots });

describe('review: receipt tampering', () => {
  it('rejects every single-field mutation of the record', async () => {
    const base = receiptFor(1);
    for (const key of Object.keys(base.record) as Array<keyof AccessRecord>) {
      const value = base.record[key];
      const mutated =
        typeof value === 'number' ? value + 1 : value === null ? 'x' : `${JSON.stringify(value)}x`;
      const result = await verify({ ...base, record: { ...base.record, [key]: mutated } });
      expect(result.valid, key).toBe(false);
    }
    // An extra field or a missing one changes the digest too.
    expect((await verify({ ...base, record: { ...base.record, extra: 1 } })).valid).toBe(false);
    const { endUserHash: _e, ...less } = base.record;
    expect((await verify({ ...base, record: less })).valid).toBe(false);
  });

  it('rejects truncated, extended, reordered and malformed proofs', async () => {
    const base = receiptFor(2);
    expect((await verify(base)).valid).toBe(true);
    expect((await verify({ ...base, proof: base.proof.slice(0, -1) })).valid).toBe(false);
    expect((await verify({ ...base, proof: [...base.proof, base.proof[0]] })).valid).toBe(false);
    expect((await verify({ ...base, proof: [...base.proof].reverse() })).valid).toBe(false);
    expect((await verify({ ...base, proof: base.proof.map((p) => p.toUpperCase()) })).valid).toBe(
      false,
    );
    expect((await verify({ ...base, proof: 'nope' })).valid).toBe(false);
    expect((await verify({ ...base, proof: undefined })).valid).toBe(false);
    expect((await verify({ ...base, leafIndex: '2' })).valid).toBe(false);
    expect((await verify({ ...base, leafIndex: 2.5 })).valid).toBe(false);
  });

  it('does not accept an interior node as a leaf (second preimage)', async () => {
    // Node over leaves 0 and 1, presented at "index 0" of a smaller tree shape with the rest of
    // the path: the leaf is always re-hashed from the record with the 0x00 prefix, so the only
    // way in would be a record whose leaf hash equals the node hash.
    const node = nodeHash(leaves[0] as Uint8Array, leaves[1] as Uint8Array);
    const base = receiptFor(0);
    const result = await verify({ ...base, proof: [toHex(node), ...base.proof.slice(1)] });
    expect(result.valid).toBe(false);
  });

  it('rejects a time-stamp taken from another checkpoint, and odd time-stamp values', async () => {
    const base = receiptFor(0);
    for (const timestamp of [v1.timestamp, '', 'AAAA', undefined, 1, {}]) {
      const result = await verify({ ...base, timestamp });
      expect(result.valid, JSON.stringify(timestamp)).toBe(false);
      expect(result.checks.timestamp).toBe('invalid');
    }
    // Trusting no root at all is not "valid" either.
    expect((await verifyReceipt(base, { jwks, tsaRoots: [] })).valid).toBe(false);
  });

  it('rejects a checkpoint of the other leaf format re-signed by the right key without a new stamp', async () => {
    const payload = await verifyCheckpoint(fixture.checkpoint, jwks);
    const key = (await importJWK(fixture.privateJwk, 'EdDSA')) as CryptoKey;
    const downgraded = await signCheckpoint({ ...payload, v: 1 }, key, fixture.privateJwk.kid);
    const result = await verify({ ...receiptFor(0), checkpoint: downgraded });
    expect(result.valid).toBe(false);
  });

  it('rejects a record dated after the stamp even when the operator signed it', async () => {
    const key = (await importJWK(fixture.privateJwk, 'EdDSA')) as CryptoKey;
    const payload = await verifyCheckpoint(fixture.checkpoint, jwks);
    const late = {
      ...(fixture.records[0] as AccessRecord),
      occurredAt: '2031-01-01T00:00:00.000Z',
    };
    const lateLeaves = [recordLeafHash(late), ...leaves.slice(1)];
    const checkpoint = await signCheckpoint(
      { ...payload, root: toHex(treeRoot(lateLeaves)) },
      key,
      fixture.privateJwk.kid,
    );
    const result = await verify({
      ...receiptFor(0),
      record: late,
      proof: inclusionProof(lateLeaves, 0).map(toHex),
      checkpoint,
    });
    expect(result.valid).toBe(false);
  });
});
