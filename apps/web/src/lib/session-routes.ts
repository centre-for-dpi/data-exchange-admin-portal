import { routing } from '../i18n/routing';

/**
 * First path segments of the pages that only make sense with a signed-in user. Without a session
 * the proxy sends the visitor to the home page (which offers "Sign in") instead of letting the
 * page answer 404. Authorization stays in the pages and the API (CLAUDE.md, rule 3): this only
 * decides where an anonymous visitor lands.
 */
const SESSION_SEGMENTS = new Set([
  'audit',
  'entity-requests',
  'invitations',
  'my-apis',
  'my-apps',
  'my-entity',
  'notifications',
  'operator',
  'regulator',
  'requests',
]);

const locales = routing.locales as readonly string[];

function split(pathname: string): { locale: string; segments: string[] } {
  const parts = pathname.split('/').filter(Boolean);
  const locale = parts[0] && locales.includes(parts[0]) ? parts.shift()! : routing.defaultLocale;
  return { locale, segments: parts };
}

export function requiresSession(pathname: string): boolean {
  const { segments } = split(pathname);
  return segments[0] !== undefined && SESSION_SEGMENTS.has(segments[0]);
}

/** Home page in the language of the requested path. */
export function homePathFor(pathname: string): string {
  const { locale } = split(pathname);
  return locale === routing.defaultLocale ? '/' : `/${locale}`;
}
