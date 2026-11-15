import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { DataSubject } from '@rid/contracts';
import { canonicalJson } from '../common/canonical-json.js';

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

/**
 * How OPA finds the data subject of an operation (ADR-0015):
 * - path: `regex` is the operation's path regex with capture groups around the subject's number
 *   (and, if any, its document type); the group numbers say which is which.
 * - body: the gateway plugin rid-data-subject reads it from the JSON body (ADR-0017) and passes
 *   it as X-RID-Body-Subject, "TYPE:NUMBER" or just "NUMBER" (then `documentType`, or the
 *   country's default). The consumer cannot assert it.
 * - none: the operation has no data subject.
 * Operations of versions published before MT-01 carry no `subject`: no reference is computed.
 */
export type BundleSubject =
  | { in: 'path'; regex: string; numberGroup: number; typeGroup?: number; documentType?: string }
  | { in: 'body'; documentType?: string }
  | { in: 'none' };

export interface BundleOperation {
  id: string;
  method: string;
  pathRegex: string;
  subject?: BundleSubject;
}

export interface BundleRoute {
  apiVersionId: string;
  classification: string;
  operations: BundleOperation[];
  /** Served through X-Road (M4-05): the policy also sets X-Road-UserId and X-Road-Issue. */
  xroad?: true;
  /** The sandbox route of a version (M4-08): only sandbox applications reach it. */
  sandbox?: true;
}

/**
 * The bundle form of an operation's x-rid-data-subject. For a path subject, the regex captures the
 * named parameters, numbered by their order in the path.
 */
export function bundleSubject(
  basePath: string,
  openapiPath: string,
  subject: DataSubject | null,
): BundleSubject | undefined {
  if (!subject) return undefined;
  if (subject.in === 'none') return { in: 'none' };
  if (subject.in === 'body') {
    // The pointers stay with the gateway plugin; OPA only reads what the plugin extracted.
    return {
      in: 'body',
      ...(subject.documentType ? { documentType: subject.documentType } : {}),
    };
  }
  const captured = [subject.name, subject.documentTypeParam].filter(Boolean);
  const order: string[] = [];
  const segments = `${basePath}${openapiPath}`.split('/').map((segment) =>
    segment
      .split(/(\{[^/{}]+\})/)
      .map((part) => {
        const param = /^\{([^/{}]+)\}$/.exec(part)?.[1];
        if (!param) return escapeRegex(part);
        if (!captured.includes(param)) return '[^/]+';
        order.push(param);
        return '([^/]+)';
      })
      .join(''),
  );
  const numberGroup = order.indexOf(subject.name) + 1;
  const typeGroup = subject.documentTypeParam ? order.indexOf(subject.documentTypeParam) + 1 : 0;
  return {
    in: 'path',
    regex: `^${segments.join('/')}$`,
    numberGroup,
    ...(typeGroup > 0 ? { typeGroup } : {}),
    ...(subject.documentType ? { documentType: subject.documentType } : {}),
  };
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
  /** sandbox applications only reach sandbox routes (M4-08). */
  environment: 'sandbox' | 'production';
  subscriptions: BundleSubscription[];
  /**
   * RFC 8705 thumbprints (x5t#S256) of the application's valid client certificates (SPIKE S-3):
   * revoking or expiring a certificate takes it out of this list.
   */
  certificates: string[];
}

/** data.json of the bundle (ARCHITECTURE.md §4.2). */
export interface BundleData {
  routes: Record<string, BundleRoute>;
  clients: Record<string, BundleClient>;
  config: {
    endUserHashSalt: string;
    /** HMAC key of the data subject reference (RID_SUBJECT_REF_KEY, ADR-0015). */
    subjectRefKey: string;
    /** Country code, part of the reference: CC 123 in one country is not CC 123 in another. */
    country: string;
    /** Person document types of the country; the first one is the default. */
    documentTypes: string[];
    /** features.mtls.required: every call needs a client certificate and a bound token. */
    mtlsRequired: boolean;
    /**
     * Nodes of the gateway (RID_GATEWAY_NODES, ADR-0020): each counts locally, so the policy
     * gives each node its share of a subscription's limit.
     */
    gatewayNodes: number;
  };
}

/** Top-level data paths the bundle owns; OPA refuses data outside them. */
export const BUNDLE_ROOTS = ['rid', 'routes', 'clients', 'config'];

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
