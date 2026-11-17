import { MFA_ACR } from '@den/contracts';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { signIn } from '../../../../auth';
import { routing } from '../../../../i18n/routing';
import { STEP_UP_COOKIE, STEP_UP_COOKIE_MAX_AGE } from '../../../../lib/step-up';

/**
 * Signs in again asking for the second factor (M3-08, ADR-0021). Keycloak keeps the session of
 * the password and only asks for the one-time code (or to set one up, the first time).
 */
export async function GET(request: NextRequest): Promise<never> {
  // Only a known locale: the redirect after the code never goes to a path the query chose.
  const requested = request.nextUrl.searchParams.get('locale') ?? '';
  const locale = (routing.locales as readonly string[]).includes(requested)
    ? requested
    : routing.defaultLocale;
  (await cookies()).set(STEP_UP_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.AUTH_URL ?? '').startsWith('https://'),
    maxAge: STEP_UP_COOKIE_MAX_AGE,
    path: '/',
  });
  const home = locale === routing.defaultLocale ? '/' : `/${locale}`;
  return signIn('keycloak', { redirectTo: home }, { acr_values: MFA_ACR });
}
