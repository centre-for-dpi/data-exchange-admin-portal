/**
 * The proxy refreshes an expiring access token and sets the new session cookie for the browser,
 * but the page (or server action) of the same request reads the cookie the browser sent, so it
 * would call the API with the expired token (M-21). Next.js lets a proxy rewrite the request the
 * rest of the app sees through `x-middleware-override-headers` and `x-middleware-request-<name>`
 * response headers: this copies the session cookies of the response's `Set-Cookie` into the
 * request's `Cookie` header that way.
 */

const SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

function parseSetCookie(line: string): { name: string; value: string; removed: boolean } | null {
  const [pair = '', ...attributes] = line.split(';');
  const at = pair.indexOf('=');
  if (at < 1) return null;
  const name = pair.slice(0, at).trim();
  if (!SESSION_COOKIE.test(name)) return null;
  const value = pair.slice(at + 1).trim();
  const expired = attributes.some((a) => /^\s*max-age\s*=\s*0*\s*$/i.test(a));
  return { name, value, removed: value === '' || expired };
}

/** The request's Cookie header with the session cookies the response sets (or deletes) applied. */
export function applySessionCookies(cookieHeader: string, setCookies: string[]): string | null {
  const updates = setCookies.map(parseSetCookie).filter((c) => c !== null);
  if (updates.length === 0) return null;
  const kept = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !SESSION_COOKIE.test(part.slice(0, part.indexOf('=')).trim()));
  for (const { name, value, removed } of updates) if (!removed) kept.push(`${name}=${value}`);
  return kept.join('; ');
}

/** Makes the refreshed session cookie visible to the render and the server actions of this request. */
export function forwardSessionCookies(request: Request, response: Response): void {
  const merged = applySessionCookies(
    request.headers.get('cookie') ?? '',
    response.headers.getSetCookie(),
  );
  if (merged === null) return;
  const overridden = (response.headers.get('x-middleware-override-headers') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  // The override replaces the request headers as a whole: carry the ones the request has.
  if (overridden.length === 0) {
    for (const [name, value] of request.headers) {
      if (name !== 'cookie') response.headers.set(`x-middleware-request-${name}`, value);
      overridden.push(name);
    }
  }
  if (!overridden.includes('cookie')) overridden.push('cookie');
  response.headers.set('x-middleware-override-headers', overridden.join(','));
  response.headers.set('x-middleware-request-cookie', merged);
}
