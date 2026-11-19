/** Keys that must never reach the audit log (CLAUDE.md: "solo campos de dominio, nunca secretos"). */
const SECRET_KEY =
  /secret|password|passwd|token|credential|private_?key|authorization|cookie|api_?key/i;
/**
 * `tokenId`, `credentialId`: the identifier of a row that holds a secret, not the secret. Such a
 * key is kept only when its value is a UUID (what every row id in the portal is); a free-form
 * string under a key ending in `Id` stays redacted, so a secret smuggled under that name is lost.
 */
const IDENTIFIER_KEY = /(?:[a-z0-9]Id|_id)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 8;

export const REDACTED = '[redacted]';

/**
 * Returns a JSON-safe copy of a domain snapshot: secret-looking keys are replaced by a marker,
 * Dates become ISO strings, bigints become strings, functions and undefined are dropped.
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeForAudit(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const identifier = IDENTIFIER_KEY.test(key) && typeof item === 'string' && UUID.test(item);
      if (SECRET_KEY.test(key) && !identifier) {
        out[key] = REDACTED;
        continue;
      }
      const clean = sanitizeForAudit(item, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return value;
}
