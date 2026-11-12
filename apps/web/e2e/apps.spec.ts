import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M1-06: an app developer creates an application, sees the secret once and gets a real
// client_credentials token from the gateway realm once the Keycloak reconciler has run.
const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

const decodeJwt = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

test.describe('applications and OAuth2 credentials', () => {
  test('carlos creates an application and obtains a gateway token', async ({ page }) => {
    await signIn(page, 'carlos.dev', '/my-apps');
    await page.getByRole('link', { name: 'Crear aplicación' }).click();
    await expectNoAccessibilityViolations(page);

    // Validation errors are announced in the error summary.
    await page.getByRole('button', { name: 'Crear aplicación' }).click();
    await expect(page.locator('form').getByRole('alert')).toBeVisible();

    const name = `Subsidios ${Date.now().toString(36)}`;
    await page.getByLabel(/^Nombre de la aplicación/).fill(name);
    await page.getByLabel(/^Para qué la usará/).fill('Verifica requisitos de subsidios.');
    await page.getByLabel(/^Entorno/).selectOption('sandbox');
    await page.getByLabel(/^Correo del contacto técnico/).fill('dev@programas.demo.rid.example');
    await page.getByRole('button', { name: 'Crear aplicación' }).click();

    const clientId = (await page.getByTestId('client-id').textContent()) ?? '';
    const clientSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
    expect(clientId).toMatch(/^rid-app-[0-9a-f-]{36}$/);
    expect(clientSecret.length).toBeGreaterThanOrEqual(43);
    await expectNoAccessibilityViolations(page);

    await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    // The page refreshes itself until the reconciler has created the Keycloak client.
    await expect(page.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });
    await expect(page.getByText(clientSecret)).toHaveCount(0);
    await expect(page.locator('pre').getByText(/TU_SECRETO/)).toBeVisible();
    await expectNoAccessibilityViolations(page);

    const response = await fetch(
      `${keycloakUrl}/realms/rid-gateway/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
      },
    );
    expect(response.status).toBe(200);
    const claims = decodeJwt(((await response.json()) as { access_token: string }).access_token);
    expect(claims.azp).toBe(clientId);
    expect([claims.aud].flat()).toContain('rid-gateway');

    await page.goto('/my-apps');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('Lista');
  });

  test('a member without the developer role sees applications read-only', async ({ page }) => {
    await signIn(page, 'pedro.publicador', '/my-apps');
    await expect(page.getByRole('heading', { level: 1, name: 'Mis aplicaciones' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Crear aplicación' })).toHaveCount(0);
    await page.goto('/my-apps/new');
    await expect(page.getByRole('heading', { name: 'Crear aplicación' })).toHaveCount(0);
  });
});
