import { expect, test } from '@playwright/test';
import { enterOneTimeCode, expectNoAccessibilityViolations, keycloakLogin, totp } from './helpers';

/** The web's own address, wherever the suite runs (DEN_WEB_URL). */
const webOrigin = (process.env.DEN_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const at = (path: string) => `${webOrigin}${path}`;

// M0 closing criterion: the web shows login working against Keycloak.
test.describe('login with Keycloak', () => {
  test('a seed user signs in, sees the signed-in home and signs out of both sessions', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await keycloakLogin(page, 'carlos.dev');

    await expect(page).toHaveURL(at('/'));
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Hola, Carlos Desarrollador');
    await expect(page.getByText('Sesión iniciada como Carlos Desarrollador')).toBeVisible();
    // Signed in without roles yet (they come from the API in M1-02): catalogue is visible.
    await expect(
      page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('link', {
        name: 'Catálogo',
      }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);

    // The browser never receives tokens: the session endpoint only exposes the user.
    const session = (await (await page.request.get('/api/auth/session')).json()) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(session)).not.toMatch(/accessToken|idToken|access_token|id_token/);
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name.startsWith('authjs.session-token'));
    expect(sessionCookie?.httpOnly).toBe(true);

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(at('/'));
    await expect(page.getByRole('button', { name: 'Iniciar sesión' }).first()).toBeVisible();

    // Keycloak's SSO session is closed too: signing in again asks for credentials.
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await expect(page).toHaveURL(/\/realms\/den-portal\//);
    await expect(page.locator('#username')).toBeVisible();
  });

  test('keeps the language after signing in from the English site', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('button', { name: 'Sign in' }).first().click();
    await keycloakLogin(page, 'lucia.datos');
    await expect(page).toHaveURL(at('/en'));
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Hello, Lucía Datos');
  });

  test('a data steward also types the one-time code, and a wrong one is refused (M3-08)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await page.locator('#username').fill('lucia.datos');
    await page.locator('#password').fill(process.env.DEN_DEMO_USER_PASSWORD ?? 'den-demo-password');
    await page.locator('#kc-login').click();

    // The portal sees the session lacks the second factor and asks Keycloak for it.
    await expect(page.locator('#otp')).toBeVisible();
    const wrong = String((Number(totp()) + 1) % 1_000_000).padStart(6, '0');
    await page.locator('#otp').fill(wrong);
    await page.locator('#kc-login').click();
    await expect(page.locator('#input-error-otp')).not.toBeEmpty();

    await enterOneTimeCode(page, 'lucia.datos');
    await expect(page).toHaveURL(at('/'));
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Hola, Lucía Datos');
    await expect(page.getByText('Entidad: ')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'segundo factor' })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
  });
});
