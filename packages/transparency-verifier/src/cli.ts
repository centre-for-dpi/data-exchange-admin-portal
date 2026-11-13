#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { JSONWebKeySet } from 'jose';
import { type Receipt, verifyReceipt } from './receipt.js';
import { certificatesInPem } from './tsa.js';

/**
 * rid-verify-receipt: checks a transparency receipt with public material only, without asking
 * the portal anything (ADR-0016).
 *
 *   rid-verify-receipt receipt.json --jwks operator-jwks.json --tsa-root tsa-root.pem
 *
 * --jwks and --tsa-root take a file path or an http(s) URL. Exit code 0 if the receipt is valid,
 * 1 if it is not, 2 on a usage error.
 */
const USAGE =
  'Usage: rid-verify-receipt <receipt.json> --jwks <file|url> --tsa-root <file|url> [--allow-pending]';

const load = async (source: string): Promise<string> => {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return res.text();
  }
  return readFile(source, 'utf8');
};

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        jwks: { type: 'string' },
        'tsa-root': { type: 'string', multiple: true },
        'allow-pending': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const [receiptPath] = parsed.positionals;
  const { jwks, 'tsa-root': tsaRoots = [], 'allow-pending': allowPending } = parsed.values;
  if (!receiptPath || !jwks || tsaRoots.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const receipt = JSON.parse(await load(receiptPath)) as Receipt;
  const keys = JSON.parse(await load(jwks)) as JSONWebKeySet;
  const roots = (await Promise.all(tsaRoots.map(load))).flatMap(certificatesInPem);
  const result = await verifyReceipt(receipt, {
    jwks: keys,
    tsaRoots: roots,
    allowPendingTimestamp: allowPending ?? false,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
  return result.valid ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
