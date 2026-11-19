import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

/** The keys of the ALLOWED table of a Fluent Bit Lua filter. */
function allowed(file: string): string[] {
  const source = readFileSync(fromRoot('infra/fluent-bit', file), 'utf8');
  const table = /local ALLOWED = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  return [...table.matchAll(/^\s*([a-z_]+)\s*=\s*true,/gm)].map((m) => m[1] ?? '').sort();
}

/** Never in any log: paths, query strings, bodies, tokens, the official or the subject in clear. */
const FORBIDDEN = [
  'uri',
  'path',
  'request_uri',
  'upstream_uri',
  'args',
  'query',
  'body',
  'authorization',
  'end_user',
  'data_subject',
  'body_subject',
  'document_number',
];

describe('Fluent Bit allowlists, second privacy barrier (ARCHITECTURE.md §8, M3-06)', () => {
  it('the access log keeps metadata only, the official as its hash and the deny reason', () => {
    const keys = allowed('allowlist.lua');
    expect(keys).toEqual(
      [
        'bytes_sent',
        'consumer_app',
        'consumer_entity',
        'deny_reason',
        'end_user_hash',
        'gateway_node',
        'latency_ms',
        'method',
        'operation',
        'purpose',
        'request_id',
        'route_id',
        'status',
        'subscription_id',
        'ts',
        'upstream_latency_ms',
      ].sort(),
    );
    for (const key of FORBIDDEN) expect(keys, key).not.toContain(key);
    // Whose data was consulted never reaches analytics (ADR-0015).
    expect(keys).not.toContain('subject_ref');
  });

  it('the transparency record keeps the pseudonyms, never a value in clear', () => {
    const keys = allowed('transparency.lua');
    expect(keys).toContain('end_user_hash');
    expect(keys).toContain('subject_ref');
    for (const key of FORBIDDEN) expect(keys, key).not.toContain(key);
    // The consumer's X-Request-Id is free text: never next to the pseudonym (M-16).
    expect(keys).not.toContain('request_id');
  });
});
