import { isIP } from 'node:net';
import { headers } from 'next/headers';

/**
 * The visitor's address, from the X-Forwarded-For the proxy in front of the web set (M-27): its
 * last entry, the one the proxy appended for the peer it saw. Earlier entries came from the client
 * and prove nothing. Next.js fills the header with the socket's address only when it is absent.
 */
export function clientAddress(forwardedFor: string | null | undefined): string | undefined {
  const last = forwardedFor?.split(',').pop()?.trim();
  return last && isIP(last) ? last : undefined;
}

/**
 * X-Forwarded-For for a call to the API made on behalf of the request being handled, so the API
 * limits and audits the visitor rather than the web server. The API believes it only from the
 * addresses in DEN_TRUST_PROXY (the web's among them). Empty outside a request.
 */
export async function forwardedForHeader(): Promise<Record<string, string>> {
  try {
    const address = clientAddress((await headers()).get('x-forwarded-for'));
    return address ? { 'x-forwarded-for': address } : {};
  } catch {
    return {};
  }
}
