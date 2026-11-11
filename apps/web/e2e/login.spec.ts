import { expect, test } from '@playwright/test';
import { expectNoAccessibilityViolations, keycloakLogin } from './helpers';

// M0 closing criterion: the web shows login working against Keycloak.
test.describe('login with Keycloak', () => {
  test('a seed user signs in, sees the signed-in home and signs out of both sessions', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await keycloakLogin(page, 'carlos.dev');

    await expect(page).toHaveURL(/localhost:3000\/$/);
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
    await expect(page).toHaveURL(/localhost:3000\/$/);
    await expect(page.getByRole('button', { name: 'Iniciar sesión' }).first()).toBeVisible();

    // Keycloak's SSO session is closed too: signing in again asks for credentials.
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await expect(page).toHaveURL(/\/realms\/rid-portal\//);
    await expect(page.locator('#username')).toBeVisible();
  });

  test('keeps the language after signing in from the English site', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('button', { name: 'Sign in' }).first().click();
    await keycloakLogin(page, 'lucia.datos');
    await expect(page).toHaveURL(/localhost:3000\/en$/);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Hello, Lucía Datos');
  });
});
