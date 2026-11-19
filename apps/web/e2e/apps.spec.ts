import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { makeCsr } from './csr';
import { signIn } from './flows';
import {
  certificateOf,
  gatewayToken,
  gatewayTokenResponse,
  issueCertificate,
} from './gateway-flows';
import { country, expectNoAccessibilityViolations } from './helpers';

// M1-06: an app developer creates an application, sees the secret once and gets a real
// client_credentials token from the gateway once the Keycloak reconciler has run. With mTLS
// (M3-10) the token comes from the gateway's token route, bound to the application's certificate.

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
    await page.getByLabel(/^Correo del contacto técnico/).fill('dev@programas.demo.den.example');
    await page.getByRole('button', { name: 'Crear aplicación' }).click();

    const clientId = (await page.getByTestId('client-id').textContent()) ?? '';
    const clientSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
    expect(clientId).toMatch(/^den-app-[0-9a-f-]{36}$/);
    expect(clientSecret.length).toBeGreaterThanOrEqual(43);
    await expectNoAccessibilityViolations(page);

    await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    // The page refreshes itself until the reconciler has created the Keycloak client.
    await expect(page.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });
    await expect(page.getByText(clientSecret)).toHaveCount(0);
    // The guide reads the secret from the environment, never in the code (M5-08).
    await expect(
      page
        .locator('pre')
        .getByText(/DEN_CLIENT_SECRET/)
        .first(),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await issueCertificate(page, clientId);
    const claims = decodeJwt(await gatewayToken(clientId, clientSecret));
    expect(claims.azp).toBe(clientId);
    expect([claims.aud].flat()).toContain('den-gateway');
    if (country().features.mtls.required) {
      // Bound to the certificate (RFC 8705): the thumbprint of the leaf the portal issued.
      const leaf = new X509Certificate(certificateOf(clientId)?.cert ?? '');
      expect((claims.cnf as Record<string, string> | undefined)?.['x5t#S256']).toBe(
        createHash('sha256').update(leaf.raw).digest('base64url'),
      );
    }

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
    await page.getByLabel(/^Correo del contacto técnico/).fill('dev@programas.demo.den.example');
    await page.getByRole('button', { name: 'Crear aplicación' }).click();
    const clientId = (await page.getByTestId('client-id').textContent()) ?? '';
    await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    const section = page.getByRole('region', { name: 'Certificado de cliente (mTLS)' });
    // The commands per shell (P-05), with this application's client ID; arrows move the tabs.
    const posixTab = section.getByRole('tab', { name: 'Linux o macOS' });
    await expect(posixTab).toHaveAttribute('aria-selected', 'true');
    await expect(section.getByTestId('csr-posix')).toContainText(`id=${clientId}`);
    await expect(section.getByTestId('csr-posix')).toContainText('-subj "/CN=$id"');
    await expect(section.getByTestId('csr-posix')).toContainText('umask 077');
    await expect(section.getByTestId('csr-posix')).not.toContainText('MSYS_NO_PATHCONV');
    await expectNoAccessibilityViolations(page);
    await posixTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(section.getByRole('tab', { name: 'Windows: Git Bash' })).toBeFocused();
    await expect(section.getByTestId('csr-gitBash')).toContainText('MSYS_NO_PATHCONV=1 openssl');
    await expect(section.getByTestId('csr-posix')).toBeHidden();
    await page.keyboard.press('End');
    await expect(section.getByRole('tab', { name: 'Windows: PowerShell' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(section.getByTestId('csr-powershell')).toContainText(`$id = '${clientId}'`);
    await expect(section.getByTestId('csr-powershell')).toContainText(
      `throw '${clientId}.key ya existe: no se sobrescribe.'`,
    );
    await expect(section.getByText(`subject=CN=${clientId}`)).toBeVisible();
    await expect(section.getByTestId('csr-script')).toHaveText(
      `bash entity-check.sh csr ${clientId}`,
    );
    await expectNoAccessibilityViolations(page);

    // entity-check.sh, offered next to them, is the repository's script.
    const scriptDownload = page.waitForEvent('download');
    await section.getByRole('link', { name: 'entity-check.sh' }).click();
    const script = await scriptDownload;
    expect(script.suggestedFilename()).toBe('entity-check.sh');
    expect(await readFile((await script.path()) ?? '')).toEqual(
      await readFile(new URL('../../../scripts/entity-check.sh', import.meta.url)),
    );

    // A CSR for another application is refused before the CA, with a translated message.
    const csrField = section.getByLabel(/^Solicitud de certificado \(CSR\)/);
    await csrField.fill((await makeCsr('den-app-someone-else')).csr);
    await section.getByRole('button', { name: 'Solicitar certificado' }).click();
    await expect(section.getByText(/debe nombrar solo a esta aplicación: CN igual/)).toBeVisible();
    await expectNoAccessibilityViolations(page);

    const { csr, keyPem } = await makeCsr(clientId);
    await csrField.fill(csr);
    await section.getByRole('button', { name: 'Solicitar certificado' }).click();
    const issued = section.getByRole('status').filter({ hasText: 'El certificado está listo' });
    await expect(issued).toBeVisible();

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
    // With a valid certificate, a new request renews it (M3-04).
    await expect(
      section.getByText(/Puedes pedir un certificado nuevo para renovarlo/),
    ).toBeVisible();
    await expect(section.getByRole('button', { name: 'Solicitar certificado' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    // In English, the commands say it in English too (P-05).
    await page.goto(new URL(page.url()).pathname.replace(/^\/my-apps\//, '/en/my-apps/'));
    const english = page.getByRole('region', { name: 'Client certificate (mTLS)' });
    await english.getByRole('tab', { name: 'Windows: PowerShell' }).click();
    await expect(english.getByTestId('csr-powershell')).toContainText(
      `throw '${clientId}.key already exists: it is not overwritten.'`,
    );
    await expect(
      english.getByRole('tablist', { name: "Shell on the application's server" }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });

  test('carlos rotates the secret: both work during the window, then he revokes the old one (M3-04)', async ({
    page,
  }) => {
    await signIn(page, 'carlos.dev', '/my-apps/new');
    const name = `Rotación ${Date.now().toString(36)}`;
    await page.getByLabel(/^Nombre de la aplicación/).fill(name);
    await page.getByLabel(/^Para qué la usará/).fill('Prueba la rotación del secreto.');
    await page.getByLabel(/^Entorno/).selectOption('sandbox');
    await page.getByLabel(/^Correo del contacto técnico/).fill('dev@programas.demo.den.example');
    await page.getByRole('button', { name: 'Crear aplicación' }).click();
    const clientId = (await page.getByTestId('client-id').textContent()) ?? '';
    const oldSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
    await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await expect(page.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Rotar el secreto' }).click();
    const newSecret = (await page.getByTestId('rotated-secret').textContent()) ?? '';
    expect(newSecret.length).toBeGreaterThanOrEqual(43);
    expect(newSecret).not.toBe(oldSecret);
    await expectNoAccessibilityViolations(page);
    // With mTLS the token route also needs the application's certificate (M3-10).
    await page.reload();
    await issueCertificate(page, clientId);

    const token = (secret: string) => gatewayTokenResponse(clientId, secret).then((r) => r.status);
    // The reconciler applies the rotation in Keycloak within seconds.
    await expect.poll(() => token(newSecret), { timeout: 60_000 }).toBe(200);
    expect(await token(oldSecret)).toBe(200);

    await page.reload();
    await expect(page.getByTestId('works-until')).toBeVisible();
    // The certificate has a revoke form too: only the previous secret's.
    const revokeSecret = page.getByRole('group').filter({ hasText: 'Revocar el secreto anterior' });
    await revokeSecret.getByText('Revocar el secreto anterior').click();
    await revokeSecret.getByLabel(/^Motivo/).fill('El sistema ya usa el secreto nuevo');
    await revokeSecret.getByRole('button', { name: 'Revocar ahora' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Credencial revocada.' }),
    ).toBeVisible();
    await expect.poll(() => token(oldSecret), { timeout: 60_000 }).toBe(401);
    expect(await token(newSecret)).toBe(200);
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
