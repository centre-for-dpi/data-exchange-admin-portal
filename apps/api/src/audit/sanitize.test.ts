import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeForAudit } from './sanitize.js';

describe('sanitizeForAudit', () => {
  it('redacts secret-looking keys at any depth', () => {
    expect(
      sanitizeForAudit({
        name: 'App',
        clientSecret: 's3cr3t',
        credentials: [{ kind: 'client_secret', value: 'x' }],
        nested: { accessToken: 'abc', apiKey: 'k', Password: 'p', keep: 1 },
      }),
    ).toEqual({
      name: 'App',
      clientSecret: REDACTED,
      credentials: REDACTED,
      nested: { accessToken: REDACTED, apiKey: REDACTED, Password: REDACTED, keep: 1 },
    });
  });

  it('keeps the UUID identifiers of rows that hold a secret (B-03)', () => {
    const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(
      sanitizeForAudit({
        tokenId: id,
        credentialId: id,
        token_id: id,
        token: id,
        enrollmentToken: 'abc',
        tokenId2: 'x',
      }),
    ).toEqual({
      tokenId: id,
      credentialId: id,
      token_id: id,
      token: REDACTED,
      enrollmentToken: REDACTED,
      tokenId2: REDACTED,
    });
  });

  it('redacts an identifier-looking key that does not hold a UUID', () => {
    expect(sanitizeForAudit({ tokenId: 'sk-live-abc', credentialId: { value: 'x' } })).toEqual({
      tokenId: REDACTED,
      credentialId: REDACTED,
    });
  });

  it('makes values JSON-safe', () => {
    const date = new Date('2026-11-11T12:00:00Z');
    expect(sanitizeForAudit({ at: date, n: 10n, f: () => 1, u: undefined, list: [date] })).toEqual({
      at: '2026-11-11T12:00:00.000Z',
      n: '10',
      list: ['2026-11-11T12:00:00.000Z'],
    });
  });

  it('truncates deeply nested structures', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(sanitizeForAudit(deep))).toContain('[truncated]');
  });
});
