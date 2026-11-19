import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { auth } from './auth';
import { routing } from './i18n/routing';
import { contentSecurityPolicy, newNonce, originOf } from './lib/security-headers';
import { forwardSessionCookies } from './lib/session-cookie';
import { homePathFor, requiresSession } from './lib/session-routes';

const intl = createMiddleware(routing);

// auth() runs the jwt callback on every navigation, so an access token close to expiry is
// refreshed and the session cookie rewritten before server components call the API.
const withAuth = auth((request) => {
  // No session (never signed in, or expired): the home page offers "Sign in"; a 404 would not.
  if (!request.auth && requiresSession(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL(homePathFor(request.nextUrl.pathname), request.nextUrl));
  }
  return intl(request);
});

/**
 * Auth.js hands the handler a request with the public origin (AUTH_URL). Behind a reverse proxy
 * that origin differs from the server's own, so next-intl's internal rewrite (/ -> /es) would
 * look external and Next would proxy it over the network, back through the proxy, into a
 * redirect loop. Rewrites are pinned to the origin of the request this server received.
 */
export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  // A fresh nonce for this page (M3-09). Next.js reads it from the request's CSP header and puts
  // it on its scripts; next-intl and Auth.js forward the request headers they receive.
  const csp = contentSecurityPolicy({
    nonce: newNonce(),
    development: process.env.NODE_ENV === 'development',
    formTargets: [originOf(process.env.KEYCLOAK_URL ?? 'http://localhost:8080')].filter(
      (origin): origin is string => origin !== undefined && origin !== request.nextUrl.origin,
    ),
    https: (process.env.AUTH_URL ?? '').startsWith('https://'),
  });
  request.headers.set('content-security-policy', csp);

  const response = await withAuth(request, event as never);
  response?.headers.set('content-security-policy', csp);
  // A token refreshed here is also the one this request's page and server actions use (M-21).
  if (response) forwardSessionCookies(request, response);
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
  // Everything except Auth.js, the branding route, document downloads (/files), the kit mirror
  // (/kit/<version>/<file>), Next internals and static files. Only static extensions are
  // excluded: a route parameter with a dot in it still goes through the proxy (B-26).
  matcher: [
    '/((?!api|branding|files|_next|_vercel|kit/.+|.*\\.(?:ico|png|jpe?g|gif|svg|webp|avif|css|js|map|txt|xml|json|woff2?|ttf|otf|webmanifest)$).*)',
  ],
};
