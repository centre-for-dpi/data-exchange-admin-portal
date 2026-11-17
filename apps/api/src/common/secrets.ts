import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Values the portal keeps sealed (AES-256-GCM with RID_SECRETS_KEY): the client secret of an
 * application until the Keycloak reconciler has set it on the client (SPEC.md §4.3), the private
 * keys of the gateway's certificates and of its assertion keys.
 *
 * The key can be rotated (M6, ASVS 11.1): each sealed value names the key that sealed it
 * (`v2.<kid>.<iv>.<tag>.<ciphertext>`, kid = the first 8 hex digits of the key's SHA-256). The
 * keys in RID_SECRETS_KEYS_PREVIOUS (comma-separated) still open what they sealed, including the
 * older `v1` values that name no key, until `secrets:reseal` has sealed everything again with the
 * current key (OPERATIONS.md §5.6). New values are always sealed with RID_SECRETS_KEY.
 */
const CURRENT_VERSION = 'v2';

/** 256 bits of entropy, URL-safe. */
export const generateClientSecret = (): string => randomBytes(32).toString('base64url');

export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');

interface Key {
  id: string;
  bytes: Buffer;
}

function parseKey(raw: string, name: string): Key {
  const bytes = Buffer.from(raw.trim(), 'base64');
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes };
}

/** The current key, then the previous ones. Read on every call: rotation needs no restart. */
function keyring(): { current: Key; previous: Key[] } {
  const raw = process.env.RID_SECRETS_KEY;
  if (!raw) throw new Error('RID_SECRETS_KEY is not set (see .env.example)');
  const current = parseKey(raw, 'RID_SECRETS_KEY');
  const previous = (process.env.RID_SECRETS_KEYS_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => parseKey(k, 'RID_SECRETS_KEYS_PREVIOUS'));
  return { current, previous };
}

/** Id of the key that seals new values (logged by secrets:reseal, never the key itself). */
export const currentSecretsKeyId = (): string => keyring().current.id;

/** Encrypts with AES-256-GCM; `context` (e.g. the credential id) is bound as additional data. */
export function seal(plaintext: string, context: string): string {
  const { current } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.bytes, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [CURRENT_VERSION, current.id, iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

function decrypt(key: Key, iv: string, tag: string, ciphertext: string, context: string): string {
  // A full 16-byte tag only: a truncated one would weaken the integrity check (M6-01, ASVS V11).
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(iv, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Decrypts a value produced by `seal`; throws if it was tampered with or the context differs. */
export function open(sealed: string, context: string): string {
  const { current, previous } = keyring();
  const parts = sealed.split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid = '', iv = '', tag = '', ciphertext = ''] = parts;
    const key = [current, ...previous].find((k) => k.id === kid);
    if (!key) {
      throw new Error(
        `Sealed with key ${kid}, which is neither RID_SECRETS_KEY nor a previous one`,
      );
    }
    return decrypt(key, iv, tag, ciphertext, context);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    // Sealed before keys had ids: the current key, then the previous ones. GCM's tag tells.
    const [, iv = '', tag = '', ciphertext = ''] = parts;
    for (const key of [current, ...previous]) {
      try {
        return decrypt(key, iv, tag, ciphertext, context);
      } catch {
        // not this key
      }
    }
    throw new Error('Sealed value: no configured key opens it (or it was tampered with)');
  }
  throw new Error('Unsupported sealed value');
}

/** True when the value is not sealed with the current key: secrets:reseal seals it again. */
export function needsReseal(sealed: string): boolean {
  const parts = sealed.split('.');
  return !(parts[0] === CURRENT_VERSION && parts[1] === keyring().current.id);
}
