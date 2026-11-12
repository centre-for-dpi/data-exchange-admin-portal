import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Escapes RE2 metacharacters (OPA's regex.match uses Go's RE2). */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Anchored regex of an operation on the full public path (SPIKE S-1: OPA sees the gateway path,
 * prefix included). Each OpenAPI `{param}` matches exactly one path segment.
 */
export function pathRegex(basePath: string, openapiPath: string): string {
  const segments = `${basePath}${openapiPath}`
    .split('/')
    // A parameter may fill a segment or part of it (/{id}.json); it never spans a slash.
    .map((segment) =>
      segment
        .split(/(\{[^/{}]+\})/)
        .map((part) => (/^\{[^/{}]+\}$/.test(part) ? '[^/]+' : escapeRegex(part)))
        .join(''),
    );
  return `^${segments.join('/')}$`;
}

export interface BundleRoute {
  apiVersionId: string;
  classification: string;
  operations: Array<{ id: string; method: string; pathRegex: string }>;
}

export interface BundleSubscription {
  id: string;
  route: string;
  operations: string[];
  purposes: string[];
  validFrom: string;
  validUntil: string;
  endUserRequired: boolean;
  rateLimitPerMinute: number;
}

export interface BundleClient {
  status: 'active' | 'suspended';
  entityId: string;
  entitySlug: string;
  applicationId: string;
  subscriptions: BundleSubscription[];
  revokedCertFingerprints: string[];
}

/** data.json of the bundle (ARCHITECTURE.md §4.2). */
export interface BundleData {
  routes: Record<string, BundleRoute>;
  clients: Record<string, BundleClient>;
  config: { endUserHashSalt: string };
}

/** Top-level data paths the bundle owns; OPA refuses data outside them. */
export const BUNDLE_ROOTS = ['rid', 'routes', 'clients', 'config'];

/** JSON with object keys sorted, so equal content always yields the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

// --- tar (ustar) ---------------------------------------------------------------------------

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii'); // mode
  header.write(octal(0, 8), 108, 8, 'ascii'); // uid
  header.write(octal(0, 8), 116, 8, 'ascii'); // gid
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii'); // mtime: fixed, so archives are reproducible
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces)
  header.write('0', 156, 1, 'ascii'); // regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/** A gzipped tar of the files, in the given order, with fixed metadata (deterministic). */
export function tarGz(files: ReadonlyArray<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.content, 'utf8');
    parts.push(tarHeader(file.name, body.length), body);
    const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export interface BuiltBundle {
  archive: Buffer;
  revision: string;
}

/**
 * The bundle archive: policies, data.json and a manifest whose revision is the hash of the
 * content (policies + data). The same content always gives the same archive and revision.
 */
export function buildBundle(
  policies: ReadonlyArray<{ path: string; source: string }>,
  data: BundleData,
): BuiltBundle {
  const dataJson = canonicalJson(data);
  const sorted = [...policies].sort((a, b) => (a.path < b.path ? -1 : 1));
  const hash = createHash('sha256');
  for (const p of sorted) hash.update(`${p.path}\n${p.source}\n`);
  hash.update(dataJson);
  const revision = hash.digest('hex');
  const manifest = canonicalJson({ revision, roots: BUNDLE_ROOTS });
  const archive = tarGz([
    { name: '.manifest', content: manifest },
    { name: 'data.json', content: dataJson },
    ...sorted.map((p) => ({ name: p.path, content: p.source })),
  ]);
  return { archive, revision };
}
