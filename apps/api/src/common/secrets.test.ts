import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  currentSecretsKeyId,
  generateClientSecret,
  hashSecret,
  needsReseal,
  open,
  seal,
} from './secrets.js';

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

describe('rotation of RID_SECRETS_KEY (ASVS 11.1)', () => {
  const newKey = () => randomBytes(32).toString('base64');
  /** A v1 value as the portal sealed it before keys had ids. */
  const sealV1 = (plaintext: string, context: string, key: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
    cipher.setAAD(Buffer.from(context));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  };
  afterEach(() => {
    delete process.env.RID_SECRETS_KEYS_PREVIOUS;
  });

  it('names the key that sealed a value', () => {
    process.env.RID_SECRETS_KEY = newKey();
    const sealed = seal('x', 'c');
    expect(sealed.split('.')).toHaveLength(5);
    expect(sealed.split('.')[0]).toBe('v2');
    expect(sealed.split('.')[1]).toBe(currentSecretsKeyId());
    expect(needsReseal(sealed)).toBe(false);
  });

  it('opens with a previous key what it sealed, and marks it for resealing', () => {
    const oldKey = newKey();
    process.env.RID_SECRETS_KEY = oldKey;
    const sealed = seal('privada', 'gateway-cert-1');
    process.env.RID_SECRETS_KEY = newKey();
    expect(() => open(sealed, 'gateway-cert-1')).toThrow(/neither RID_SECRETS_KEY/);
    process.env.RID_SECRETS_KEYS_PREVIOUS = `${newKey()}, ${oldKey}`;
    expect(open(sealed, 'gateway-cert-1')).toBe('privada');
    expect(needsReseal(sealed)).toBe(true);
    const resealed = seal(open(sealed, 'gateway-cert-1'), 'gateway-cert-1');
    delete process.env.RID_SECRETS_KEYS_PREVIOUS;
    expect(open(resealed, 'gateway-cert-1')).toBe('privada');
  });

  it('opens the older v1 values with the current or a previous key', () => {
    const oldKey = newKey();
    const v1 = sealV1('secreto', 'cred-1', oldKey);
    process.env.RID_SECRETS_KEY = oldKey;
    expect(open(v1, 'cred-1')).toBe('secreto');
    expect(needsReseal(v1)).toBe(true);
    process.env.RID_SECRETS_KEY = newKey();
    expect(() => open(v1, 'cred-1')).toThrow(/no configured key/);
    process.env.RID_SECRETS_KEYS_PREVIOUS = oldKey;
    expect(open(v1, 'cred-1')).toBe('secreto');
    expect(() => open(v1, 'cred-2')).toThrow();
  });

  it('refuses a malformed previous key', () => {
    process.env.RID_SECRETS_KEY = newKey();
    process.env.RID_SECRETS_KEYS_PREVIOUS = 'corta';
    expect(() => seal('x', 'c')).toThrow(/RID_SECRETS_KEYS_PREVIOUS must be 32 bytes/);
  });
});
