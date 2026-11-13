import type { NextFetchEvent, NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { auth } from './auth';
import { routing } from './i18n/routing';

const intl = createMiddleware(routing);

// auth() runs the jwt callback on every navigation, so an access token close to expiry is
// refreshed and the session cookie rewritten before server components call the API.
const withAuth = auth((request) => intl(request));

/**
 * Auth.js hands the handler a request with the public origin (AUTH_URL). Behind a reverse proxy
 * that origin differs from the server's own, so next-intl's internal rewrite (/ -> /es) would
 * look external and Next would proxy it over the network, back through the proxy, into a
 * redirect loop. Rewrites are pinned to the origin of the request this server received.
 */
export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const response = await withAuth(request, event as never);
  const rewrite = response?.headers.get('x-middleware-rewrite');
  if (response && rewrite) {
    const target = new URL(rewrite, request.url);
    if (target.origin !== request.nextUrl.origin) {
      response.headers.set(
        'x-middleware-rewrite',
        new URL(`${target.pathname}${target.search}`, request.nextUrl.origin).toString(),
      );
    }
  }
  return response;
}

export const config = {
  // Everything except Auth.js, the branding route, Next internals and files with an extension.
  matcher: ['/((?!api|branding|_next|_vercel|.*\\..*).*)'],
};
