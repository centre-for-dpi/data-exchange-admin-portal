/**
 * JSON with object keys sorted at every level, so equal content always yields the same bytes
 * (PostgreSQL jsonb does not keep key order). Used for hashes: OPA bundle revisions and the
 * audit chain.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
