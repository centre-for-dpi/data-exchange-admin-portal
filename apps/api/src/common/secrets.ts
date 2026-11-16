import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Client secrets of consumer applications (SPEC.md §4.3): shown once, never stored in clear.
 * The portal keeps a SHA-256 to identify the credential, and a sealed copy (AES-256-GCM with
 * RID_SECRETS_KEY) only until the Keycloak reconciler has set it on the client.
 */
const VERSION = 'v1';

/** 256 bits of entropy, URL-safe. */
export const generateClientSecret = (): string => randomBytes(32).toString('base64url');

export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');

function key(): Buffer {
  const raw = process.env.RID_SECRETS_KEY;
  if (!raw) throw new Error('RID_SECRETS_KEY is not set (see .env.example)');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length !== 32) throw new Error('RID_SECRETS_KEY must be 32 bytes, base64 encoded');
  return buffer;
}

/** Encrypts with AES-256-GCM; `context` (e.g. the credential id) is bound as additional data. */
export function seal(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** Decrypts a value produced by `seal`; throws if it was tampered with or the context differs. */
export function open(sealed: string, context: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext)
    throw new Error('Unsupported sealed value');
  // A full 16-byte tag only: a truncated one would weaken the integrity check (M6-01, ASVS V11).
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
