import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Everything except Auth.js, the branding route, Next internals and files with an extension.
  matcher: ['/((?!api|branding|_next|_vercel|.*\\..*).*)'],
};
