import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateClientSecret, hashSecret, open, seal } from './secrets.js';

describe('client secrets', () => {
  beforeAll(() => {
    process.env.RID_SECRETS_KEY = randomBytes(32).toString('base64');
  });

  it('generates distinct, URL-safe secrets with 256 bits of entropy', () => {
    const a = generateClientSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateClientSecret()).not.toBe(a);
  });

  it('seals and opens a secret bound to its context', () => {
    const secret = generateClientSecret();
    const sealed = seal(secret, 'credential-1');
    expect(sealed).not.toContain(secret);
    expect(open(sealed, 'credential-1')).toBe(secret);
  });

  it('rejects a sealed value used with another context or tampered with', () => {
    const sealed = seal('s3cr3t', 'credential-1');
    expect(() => open(sealed, 'credential-2')).toThrow();
    const parts = sealed.split('.');
    const last = parts[3] ?? '';
    parts[3] = (last[0] === 'A' ? 'B' : 'A') + last.slice(1);
    expect(() => open(parts.join('.'), 'credential-1')).toThrow();
  });

  it('refuses a truncated authentication tag (M6-01)', () => {
    const parts = seal('s3cr3t', 'credential-1').split('.');
    // The tag is the third part: keep only its first 4 bytes.
    parts[2] = Buffer.from(parts[2] ?? '', 'base64url')
      .subarray(0, 4)
      .toString('base64url');
    expect(() => open(parts.join('.'), 'credential-1')).toThrow();
  });

  it('hashes deterministically', () => {
    expect(hashSecret('x')).toBe(hashSecret('x'));
    expect(hashSecret('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a missing or short key', () => {
    const saved = process.env.RID_SECRETS_KEY;
    process.env.RID_SECRETS_KEY = Buffer.from('short').toString('base64');
    expect(() => seal('x', 'c')).toThrow(/32 bytes/);
    delete process.env.RID_SECRETS_KEY;
    expect(() => seal('x', 'c')).toThrow(/not set/);
    process.env.RID_SECRETS_KEY = saved;
  });
});
