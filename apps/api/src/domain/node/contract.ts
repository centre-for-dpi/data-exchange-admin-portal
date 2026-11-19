import { createHash } from 'node:crypto';
import type { NodeContractStatus, NodeService } from '@den/contracts';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Hashes of the same OpenAPI text as the node may hold it (P-02). The kit reports the SHA-256 of
 * the raw bytes of the file it serves (a proxy service's `openapi`, or the instant API's generated
 * document, which `den-node openapi` prints byte for byte). The portal hashes the text it
 * received, which the web form may have changed on the way: a pasted document arrives trimmed and
 * with CRLF line endings, and reading an uploaded file drops a UTF-8 BOM. So the published
 * contract also accepts the same text with LF or CRLF endings, with or without one final newline
 * and with or without a BOM. Anything else (a different key order, YAML instead of JSON) is a
 * different document and differs.
 */
export function openapiHashVariants(source: string): string[] {
  const base = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
  const variants = new Set<string>();
  for (const eol of ['\n', '\r\n']) {
    const text = eol === '\n' ? base : base.replace(/\n/g, eol);
    for (const ending of ['', eol]) {
      for (const bom of ['', '\uFEFF']) variants.add(sha256(`${bom}${text}${ending}`));
    }
  }
  variants.delete(sha256(source));
  return [...variants].sort();
}

const trimSlashes = (path: string): string => path.replace(/\/+$/, '') || '/';

/**
 * The node's service that serves a version's servicePath: the one declared on that very path, or
 * else the one whose path is the longest prefix of it on a segment boundary (the node routes by
 * prefix, so `/salud` serves `/salud/v1`).
 */
export function serviceFor(
  services: readonly NodeService[],
  servicePath: string,
): NodeService | undefined {
  const wanted = trimSlashes(servicePath);
  let best: NodeService | undefined;
  for (const service of services) {
    const path = trimSlashes(service.path);
    const serves = path === wanted || path === '/' || wanted.startsWith(`${path}/`);
    if (serves && (!best || path.length > trimSlashes(best.path).length)) best = service;
  }
  return best;
}

export interface ContractComparison {
  status: NodeContractStatus;
  serviceName: string | null;
  reportedSha256: string | null;
}

/**
 * What the node serves for a published version, against the version's contract (P-02):
 * - `matches`: the service on that path reports one of the published document's hashes;
 * - `differs`: it reports another one;
 * - `not_reported`: the node declares no service there, or the service has no OpenAPI on the
 *   node (it reports no hash; its log shows `(unknown)` routes).
 */
export function compareContract(
  version: { openapiSha256: string; openapiSha256Variants: readonly string[] },
  services: readonly NodeService[],
  servicePath: string,
): ContractComparison {
  const service = serviceFor(services, servicePath);
  const reported = service?.openapiSha256 ?? null;
  if (!service || !reported) {
    return { status: 'not_reported', serviceName: service?.name ?? null, reportedSha256: null };
  }
  const accepted =
    reported === version.openapiSha256 || version.openapiSha256Variants.includes(reported);
  return {
    status: accepted ? 'matches' : 'differs',
    serviceName: service.name,
    reportedSha256: reported,
  };
}
