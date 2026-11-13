// Regenerates src/__fixtures__/receipt-fixture.json: a small sealed batch signed with a fixed
// test key and stamped by a real RFC 3161 TSA (the development one). Ed25519 signatures are
// deterministic, so the fixture stays valid for the tests.
//   node scripts/make-fixture.mjs <tsa-url> <tsa-root.pem>
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { exportJWK, generateKeyPair } from 'jose';
import * as v from '../dist/index.js';

const [tsaUrl, rootPath] = process.argv.slice(2);
if (!tsaUrl || !rootPath) throw new Error('Usage: make-fixture.mjs <tsa-url> <tsa-root.pem>');

const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const privateJwk = { ...(await exportJWK(privateKey)), kid: 'test-2026', alg: 'EdDSA', use: 'sig' };

const hex = (n) => randomBytes(n).toString('hex');
const uuid = () => crypto.randomUUID();
const records = Array.from({ length: 5 }, (_, i) => ({
  v: 1,
  id: uuid(),
  occurredAt: new Date(Date.UTC(2026, 10, 13, 12, 0, i)).toISOString(),
  subjectRef: hex(32),
  subjectSource: i % 2 ? 'body' : 'path',
  providerEntityId: uuid(),
  apiId: uuid(),
  apiVersionId: uuid(),
  operationId: i % 2 ? 'verificarAfiliacion' : 'getAfiliado',
  exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
  consumerEntityId: uuid(),
  applicationId: uuid(),
  subscriptionId: uuid(),
  purposeCode: 'eligibility_check',
  endUserHash: i === 3 ? null : hex(32),
  status: i === 4 ? 404 : 200,
  gatewayNode: 'apisix-test',
  gatewayRequestId: hex(16),
}));
const leaves = records.map((r) => v.recordLeafHash(r, 2));
const payload = {
  v: 2,
  log: 'rid-transparency-test',
  seq: 1,
  treeSize: records.length,
  root: v.toHex(v.treeRoot(leaves)),
  prev: null,
  sealedAt: '2026-11-13T12:00:10.000Z',
};
const { importJWK } = await import('jose');
const checkpoint = await v.signCheckpoint(
  payload,
  await importJWK(privateJwk, 'EdDSA'),
  privateJwk.kid,
);

const data = new TextEncoder().encode(checkpoint);
const nonce = randomBytes(8);
const res = await fetch(`${tsaUrl}/api/v1/timestamp`, {
  method: 'POST',
  headers: { 'content-type': 'application/timestamp-query' },
  body: v.timestampRequest(data, nonce),
});
if (!res.ok) throw new Error(`TSA: HTTP ${res.status}`);
const token = v.tokenFromResponse(new Uint8Array(await res.arrayBuffer()), data, nonce);

writeFileSync(
  new URL('../src/__fixtures__/receipt-fixture.json', import.meta.url),
  `${JSON.stringify(
    {
      privateJwk,
      records,
      checkpoint,
      timestamp: Buffer.from(token).toString('base64'),
      tsaRoot: readFileSync(rootPath, 'utf8'),
    },
    null,
    2,
  )}\n`,
);
console.log('fixture written');
