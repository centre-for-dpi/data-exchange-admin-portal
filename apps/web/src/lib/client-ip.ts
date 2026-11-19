import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { headers } from 'next/headers';

/** The header the reverse proxy sets on every request it sends to the web (M-27). */
export const PROXY_TOKEN_HEADER = 'x-den-proxy-token';

/**
 * The visitor's address, from the X-Forwarded-For the proxy in front of the web set: its last
 * entry, the one the proxy appended for the peer it saw. Earlier entries came from the client
 * and prove nothing.
 */
export function clientAddress(forwardedFor: string | null | undefined): string | undefined {
  const last = forwardedFor?.split(',').pop()?.trim();
  return last && isIP(last) ? last : undefined;
}

/** Whether the request came through the reverse proxy: it carries DEN_WEB_PROXY_TOKEN. */
function fromTheProxy(received: string | null, expected: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * X-Forwarded-For for a call to the API made on behalf of `incoming`, so the API limits and
 * audits the visitor rather than the web server. Next.js does not tell the web who its direct
 * peer is, so the hop is authenticated instead: the proxy adds DEN_WEB_PROXY_TOKEN in
 * X-DEN-Proxy-Token (overwriting whatever the client sent) and only then is its X-Forwarded-For
 * believed. A request that reached the web some other way, or with no token configured, forwards
 * nothing: the API then sees the web's own address. The API believes the header only from the
 * web (DEN_TRUST_PROXY).
 */
export function forwardedFor(
  incoming: Pick<Headers, 'get'>,
  expectedToken: string | undefined = process.env.DEN_WEB_PROXY_TOKEN,
): Record<string, string> {
  if (!fromTheProxy(incoming.get(PROXY_TOKEN_HEADER), expectedToken)) return {};
  const address = clientAddress(incoming.get('x-forwarded-for'));
  return address ? { 'x-forwarded-for': address } : {};
}

/** forwardedFor() for the request being handled; empty outside a request. */
export async function forwardedForHeader(): Promise<Record<string, string>> {
  try {
    return forwardedFor(await headers());
  } catch {
    return {};
  }
}
