/**
 * Canonical JSON (RFC 8785, JCS) for the values the transparency register uses: objects, arrays,
 * strings, finite numbers, booleans and null. Object keys are sorted by UTF-16 code units, which
 * is how JavaScript compares strings, and numbers use the ECMAScript serialization JCS requires.
 * Equal content always yields the same bytes, whoever computes it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`Canonical JSON: unsupported value of type ${typeof value}`);
}
