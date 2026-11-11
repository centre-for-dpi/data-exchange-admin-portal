'use server';

import { getToken } from 'next-auth/jwt';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { keycloakIssuer, signIn, signOut } from '../auth';
import { routing, type AppLocale } from '../i18n/routing';

const homePath = (locale: AppLocale): string =>
  locale === routing.defaultLocale ? '/' : `/${locale}`;

const asLocale = (value: string): AppLocale =>
  (routing.locales as readonly string[]).includes(value)
    ? (value as AppLocale)
    : routing.defaultLocale;

export async function signInAction(locale: string): Promise<void> {
  await signIn('keycloak', { redirectTo: homePath(asLocale(locale)) });
}

/**
 * Ends both sessions: the portal cookie and the Keycloak SSO session (RP-initiated logout).
 * Without the second step the next "Sign in" would silently log the same user back in.
 */
export async function signOutAction(locale: string): Promise<void> {
  const authUrl = process.env.AUTH_URL ?? '';
  const token = await getToken({
    req: { headers: await headers() },
    secret: process.env.AUTH_SECRET ?? '',
    secureCookie: authUrl.startsWith('https://'),
  });
  await signOut({ redirect: false });

  const webUrl = process.env.RID_WEB_URL ?? 'http://localhost:3000';
  const params = new URLSearchParams({
    post_logout_redirect_uri: `${webUrl}${homePath(asLocale(locale))}`,
    client_id: process.env.RID_PORTAL_WEB_CLIENT_ID ?? 'rid-portal-web',
  });
  if (typeof token?.idToken === 'string') params.set('id_token_hint', token.idToken);
  redirect(`${keycloakIssuer()}/protocol/openid-connect/logout?${params.toString()}`);
}
