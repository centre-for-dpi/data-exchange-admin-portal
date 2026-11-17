import { getLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Second factor for critical roles (M3-08, ADR-0021). The API says when the session needs it:
 * /me (`mfa.required` and not `mfa.satisfied`) or a 403 `mfa_required`. The web then signs in
 * again asking Keycloak for acr=mfa: within the Keycloak session that is only the one-time code.
 */
export const STEP_UP_PATH = '/api/session/step-up';

/** Set while a step-up is under way: if the session still lacks the factor, show a notice. */
export const STEP_UP_COOKIE = 'den-step-up';
export const STEP_UP_COOKIE_MAX_AGE = 120;

export const isMfaRequired = (problem: unknown): boolean =>
  typeof problem === 'object' &&
  problem !== null &&
  (problem as { code?: unknown }).code === 'mfa_required';

/**
 * Sends the browser to the step-up, unless one was just tried (no redirect loop when Keycloak
 * could not raise the level): then it returns and the page shows the notice instead.
 */
export async function redirectToStepUp(): Promise<void> {
  if ((await cookies()).get(STEP_UP_COOKIE)) return;
  // Back to the same language after the code.
  const locale = await getLocale().catch(() => undefined);
  redirect(locale ? `${STEP_UP_PATH}?locale=${encodeURIComponent(locale)}` : STEP_UP_PATH);
}
