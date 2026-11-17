import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

/**
 * Verification of the gateway's signed assertion (X-RID-Assertion, ADR-0024, M6-10), as a real
 * provider would do it: Node's crypto only, the gateway's public keys from the portal's JWKS.
 *
 * Accepted only when:
 *   - it is a compact JWS ES256 whose kid is in the JWKS (refetched once for an unknown kid);
 *   - the signature verifies;
 *   - `aud` is this provider and `exp` is not past (60 s of clock skew);
 *   - `req.method` and `req.uri_sha256` are those of the request received (method, path and
 *     query as they arrived);
 *   - `req.body_sha256`, when the request has a body, is the SHA-256 of those bytes.
 */
export type AssertionResult = 'verified' | 'absent' | `invalid: ${string}`;

export interface AssertionVerifierOptions {
  jwksUrl: string;
  audience: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const SKEW_S = 60;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const b64urlJson = (part: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

export function assertionVerifier(options: AssertionVerifierOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => Date.now());
  let keys = new Map<string, KeyObject>();

  async function refresh(): Promise<void> {
    const res = await fetchFn(options.jwksUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`JWKS ${res.status}`);
    const jwks = (await res.json()) as { keys?: Array<Record<string, unknown>> };
    keys = new Map(
      (jwks.keys ?? [])
        .filter((k) => typeof k.kid === 'string')
        .map((k) => [k.kid as string, createPublicKey({ key: k, format: 'jwk' })]),
    );
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    if (!keys.has(kid)) await refresh().catch(() => undefined);
    return keys.get(kid);
  }

  return async function check(
    header: string | string[] | undefined,
    request: { method: string; url: string; body?: Buffer | string },
  ): Promise<AssertionResult> {
    if (typeof header !== 'string' || header === '') return 'absent';
    const parts = header.split('.');
    if (parts.length !== 3) return 'invalid: not a compact JWS';
    const [rawHeader = '', rawClaims = '', signature = ''] = parts;
    const jose = b64urlJson(rawHeader);
    if (jose?.alg !== 'ES256' || typeof jose.kid !== 'string') return 'invalid: header';
    const key = await keyFor(jose.kid);
    if (!key) return 'invalid: unknown kid';
    const signed = verify(
      'sha256',
      Buffer.from(`${rawHeader}.${rawClaims}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    if (!signed) return 'invalid: signature';
    const claims = b64urlJson(rawClaims) ?? {};
    const seconds = Math.floor(now() / 1000);
    if (claims.aud !== options.audience) return 'invalid: audience';
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < seconds) return 'invalid: expired';
    const req = (claims.req ?? {}) as Record<string, unknown>;
    if (req.method !== request.method.toUpperCase()) return 'invalid: method';
    if (req.uri_sha256 !== sha256(request.url)) return 'invalid: uri';
    if (request.body !== undefined && request.body.length > 0) {
      if (req.body_sha256 !== sha256(request.body)) return 'invalid: body';
    }
    return 'verified';
  };
}
