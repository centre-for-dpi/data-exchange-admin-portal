import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type CryptoKey, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkpointHash, signCheckpoint, verifyCheckpoint } from './checkpoint.js';
import { inclusionProof, toHex, treeRoot } from './merkle.js';
import { type Receipt, verifyReceipt } from './receipt.js';
import { type AccessRecord, recordLeafHash } from './record.js';
import { certificatesInPem, verifyTimestampToken } from './tsa.js';

interface Fixture {
  privateJwk: JWK & { kid: string };
  records: AccessRecord[];
  checkpoint: string;
  timestamp: string;
  tsaRoot: string;
  otherRoot: string;
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '__fixtures__/receipt-fixture.json'), 'utf8'),
) as Fixture;
const { d: _private, ...publicJwk } = fixture.privateJwk;
const jwks = { keys: [publicJwk] };
const tsaRoots = certificatesInPem(fixture.tsaRoot);
const leaves = fixture.records.map(recordLeafHash);

const receiptFor = (index: number): Receipt => ({
  v: 1,
  record: fixture.records[index] as AccessRecord,
  leafIndex: index,
  proof: inclusionProof(leaves, index).map(toHex),
  checkpoint: fixture.checkpoint,
  timestamp: fixture.timestamp,
});

describe('receipt verification (ADR-0016)', () => {
  it('accepts every record of a sealed and stamped batch', async () => {
    for (let i = 0; i < fixture.records.length; i++) {
      const result = await verifyReceipt(receiptFor(i), { jwks, tsaRoots });
      expect(result.errors).toEqual([]);
      expect(result).toMatchObject({
        valid: true,
        checks: { signature: true, inclusion: true, timestamp: 'valid' },
        checkpoint: { seq: 1, treeSize: fixture.records.length, prev: null },
      });
      expect(Date.parse(result.stampedAt ?? '')).toBeGreaterThan(0);
    }
  });

  it('detects an altered record', async () => {
    const receipt = receiptFor(2);
    const altered = { ...receipt, record: { ...receipt.record, purposeCode: 'other_purpose' } };
    const result = await verifyReceipt(altered, { jwks, tsaRoots });
    expect(result.valid).toBe(false);
    expect(result.checks).toMatchObject({ signature: true, inclusion: false });
    // Moving it to another position does not help either.
    expect((await verifyReceipt({ ...receipt, leafIndex: 3 }, { jwks, tsaRoots })).valid).toBe(
      false,
    );
  });

  it('detects a record that was never in the batch', async () => {
    const intruder: AccessRecord = {
      ...(fixture.records[0] as AccessRecord),
      id: crypto.randomUUID(),
    };
    const result = await verifyReceipt({ ...receiptFor(0), record: intruder }, { jwks, tsaRoots });
    expect(result.checks.inclusion).toBe(false);
  });

  it('detects a checkpoint re-signed by someone else, or with another root', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const forged = await verifyCheckpoint(fixture.checkpoint, jwks);
    const reSigned = await signCheckpoint(forged, privateKey, fixture.privateJwk.kid);
    expect(
      (await verifyReceipt({ ...receiptFor(0), checkpoint: reSigned }, { jwks, tsaRoots })).checks
        .signature,
    ).toBe(false);

    // Signed by the right key but not the stamped checkpoint: the time-stamp no longer matches.
    const key = (await importJWK(fixture.privateJwk, 'EdDSA')) as CryptoKey;
    const otherRoot = await signCheckpoint(
      { ...forged, root: toHex(treeRoot([])) },
      key,
      fixture.privateJwk.kid,
    );
    const result = await verifyReceipt(
      { ...receiptFor(0), checkpoint: otherRoot },
      { jwks, tsaRoots },
    );
    expect(result.checks).toMatchObject({
      signature: true,
      inclusion: false,
      timestamp: 'invalid',
    });
  });

  it('trusts only the TSA roots it is given', async () => {
    const result = await verifyReceipt(receiptFor(0), {
      jwks,
      tsaRoots: certificatesInPem(fixture.otherRoot),
    });
    expect(result.valid).toBe(false);
    expect(result.checks.timestamp).toBe('invalid');
    await expect(
      verifyTimestampToken(Buffer.from(fixture.timestamp, 'base64'), new Uint8Array([1]), tsaRoots),
    ).rejects.toThrow(/other bytes/);
  });

  it('marks a batch not stamped yet as pending, valid only if the caller accepts that', async () => {
    const pending = { ...receiptFor(1), timestamp: null };
    expect(await verifyReceipt(pending, { jwks, tsaRoots })).toMatchObject({
      valid: false,
      checks: { signature: true, inclusion: true, timestamp: 'pending' },
    });
    expect(
      (await verifyReceipt(pending, { jwks, tsaRoots, allowPendingTimestamp: true })).valid,
    ).toBe(true);
  });

  it('links checkpoints by hash', async () => {
    const first = await verifyCheckpoint(fixture.checkpoint, jwks);
    expect(checkpointHash(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpointHash({ ...first, treeSize: first.treeSize + 1 })).not.toBe(
      checkpointHash(first),
    );
    const key = (await importJWK(fixture.privateJwk, 'EdDSA')) as CryptoKey;
    const second = await signCheckpoint(
      { ...first, seq: 2, prev: checkpointHash(first) },
      key,
      fixture.privateJwk.kid,
    );
    expect((await verifyCheckpoint(second, jwks)).prev).toBe(checkpointHash(first));
    // A non-first checkpoint without prev, or a first one with it, is malformed.
    const broken = await signCheckpoint({ ...first, seq: 2 }, key, fixture.privateJwk.kid);
    await expect(verifyCheckpoint(broken, jwks)).rejects.toThrow(/malformed/);
  });
});

describe('rid-verify-receipt CLI', () => {
  let dir = '';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rid-receipt-'));
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receiptFor(4)));
    writeFileSync(join(dir, 'jwks.json'), JSON.stringify(jwks));
    writeFileSync(join(dir, 'root.pem'), fixture.tsaRoot);
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    writeFileSync(
      join(dir, 'other-jwks.json'),
      JSON.stringify({
        keys: [{ ...(await exportJWK(privateKey)), d: undefined, kid: 'test-2026' }],
      }),
    );
  });

  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), resolve(import.meta.dirname, 'cli.ts'), ...args],
      { encoding: 'utf8', cwd: dir },
    );

  it('exits 0 for a valid receipt and 1 for a receipt that does not verify', () => {
    const ok = cli('receipt.json', '--jwks', 'jwks.json', '--tsa-root', 'root.pem');
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ valid: true });
    const bad = cli('receipt.json', '--jwks', 'other-jwks.json', '--tsa-root', 'root.pem');
    expect(bad.status).toBe(1);
    expect(cli('receipt.json').status).toBe(2);
  });
});
