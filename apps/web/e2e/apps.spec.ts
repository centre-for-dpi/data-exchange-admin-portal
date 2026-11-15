import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { makeCsr } from './csr';
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

  test('carlos gets a client certificate signed by the network CA (M3-01)', async ({ page }) => {
    await signIn(page, 'carlos.dev', '/my-apps/new');
    const name = `Certificado ${Date.now().toString(36)}`;
    await page.getByLabel(/^Nombre de la aplicación/).fill(name);
    await page.getByLabel(/^Para qué la usará/).fill('Consulta con certificado de cliente.');
    await page.getByLabel(/^Entorno/).selectOption('sandbox');
    await page.getByLabel(/^Correo del contacto técnico/).fill('dev@programas.demo.rid.example');
    await page.getByRole('button', { name: 'Crear aplicación' }).click();
    const clientId = (await page.getByTestId('client-id').textContent()) ?? '';
    await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    const section = page.getByRole('region', { name: 'Certificado de cliente (mTLS)' });
    await expect(section.locator('pre').getByText(`-subj "/CN=${clientId}"`)).toBeVisible();
    await expectNoAccessibilityViolations(page);

    // A CSR for another application is refused before the CA, with a translated message.
    const csrField = section.getByLabel(/^Solicitud de certificado \(CSR\)/);
    await csrField.fill((await makeCsr('rid-app-someone-else')).csr);
    await section.getByRole('button', { name: 'Solicitar certificado' }).click();
    await expect(section.getByText(/debe nombrar solo a esta aplicación: CN igual/)).toBeVisible();
    await expectNoAccessibilityViolations(page);

    const { csr, keyPem } = await makeCsr(clientId);
    await csrField.fill(csr);
    await section.getByRole('button', { name: 'Solicitar certificado' }).click();
    const issued = section.getByRole('status');
    await expect(issued).toContainText('El certificado está listo');

    const downloading = page.waitForEvent('download');
    await issued.getByRole('link', { name: 'Descargar' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`${clientId}.pem`);
    const chain = await readFile((await download.path()) ?? '', 'utf8');
    const leaf = new X509Certificate(chain);
    expect(leaf.subject).toBe(`CN=${clientId}`);
    // The certificate carries the key that never left the consumer.
    expect(leaf.checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
    expect(chain.match(/BEGIN CERTIFICATE/g)?.length).toBeGreaterThanOrEqual(2);

    // The credentials list shows it with its thumbprint; no second request while it is valid.
    await page.reload();
    await expect(page.getByTestId('certificate-fingerprint')).toHaveText(
      createHash('sha256').update(leaf.raw).digest('base64url'),
    );
    await expect(section.getByText('La aplicación ya tiene un certificado vigente.')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Solicitar certificado' })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
  });

  test('a member without the developer role sees applications read-only', async ({ page }) => {
    await signIn(page, 'pedro.publicador', '/my-apps');
    await expect(page.getByRole('heading', { level: 1, name: 'Mis aplicaciones' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Crear aplicación' })).toHaveCount(0);
    await page.goto('/my-apps/new');
    await expect(page.getByRole('heading', { name: 'Crear aplicación' })).toHaveCount(0);
  });
});
