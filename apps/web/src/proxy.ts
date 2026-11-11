import createMiddleware from 'next-intl/middleware';
import { auth } from './auth';
import { routing } from './i18n/routing';

const intl = createMiddleware(routing);

// auth() runs the jwt callback on every navigation, so an access token close to expiry is
// refreshed and the session cookie rewritten before server components call the API.
export default auth((request) => intl(request));

export const config = {
  // Everything except Auth.js, the branding route, Next internals and files with an extension.
  matcher: ['/((?!api|branding|_next|_vercel|.*\\..*).*)'],
};
