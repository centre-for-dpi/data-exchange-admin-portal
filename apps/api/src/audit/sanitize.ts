/** Keys that must never reach the audit log (CLAUDE.md: "solo campos de dominio, nunca secretos"). */
const SECRET_KEY =
  /secret|password|passwd|token|credential|private_?key|authorization|cookie|api_?key/i;
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
      if (SECRET_KEY.test(key)) {
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
