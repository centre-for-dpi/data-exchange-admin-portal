import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { openapiFile, registerApi, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M4-05: the operator registers an entity's X-Road member; the entity publishes a version that
// is consumed through X-Road, only for a service of that member (another member's service is
// refused: apps/api apis.int.test.ts). The traffic through a Security
// Server is tested against APISIX and OPA in apps/api (xroad.int.test.ts).
// The form offers X-Road only where the API runs with the operator's Security Server (DEN_XROAD_*,
// P-04); the development .env leaves it out, and then only the member is set here.
const xroadConfigured = Boolean(
  process.env.DEN_XROAD_SECURITY_SERVER_URL?.trim() && process.env.DEN_XROAD_CLIENT?.trim(),
);

test.describe('X-Road upstream (M4-05)', () => {
  test('pablo sets the X-Road member of salud; pedro registers a version on it', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const code = `9${randomUUID().replace(/\D/g, '').slice(0, 9)}`;
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'pablo.plataforma', '/operator/entities');
    const row = operator.getByRole('row', { name: /Entidad de Salud \(ficticia\)/ }).first();
    await row.getByText(/^X-Road de /).click();
    await row.getByLabel('Clase de miembro').fill('GOV');
    await row.getByLabel('Código de miembro').fill(code);
    await row.getByRole('button', { name: 'Guardar miembro X-Road' }).click();
    await expect(row.getByText('Miembro X-Road guardado.')).toBeVisible();
    await expect(row).toContainText(`X-Road: GOV/${code}`);
    await expectNoAccessibilityViolations(operator);

    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'pedro.publicador', '/my-apis');
    await registerApi(page, `xroad-${Date.now().toString(36)}`, `Afiliación X-Road ${code}`);
    await page.getByRole('link', { name: 'Nueva versión' }).click();
    if (!xroadConfigured) {
      await expect(page.getByLabel(/^Versión/)).toBeVisible();
      await expect(page.getByLabel('Servicio en X-Road')).toHaveCount(0);
      return;
    }
    await page.getByLabel(/^Versión/).fill('1.0');
    await page.getByLabel('Archivo OpenAPI (YAML o JSON)').setInputFiles(openapiFile);
    await page.getByLabel('Servicio en X-Road').check();
    await page.getByLabel(/^Instancia/).fill('CO');
    await page.getByLabel(/^Clase de miembro/).fill('GOV');
    await page.getByLabel(/^Código de miembro/).fill(code);
    await page.getByLabel(/^Código del servicio/).fill('consultaAfiliacion');
    await page.getByLabel('Verificación de requisitos de un trámite').check();
    await page.getByLabel('Nombre del dato').fill('regimen');
    await page.getByRole('button', { name: 'Crear versión' }).click();
    await expect(page.getByTestId('version-status')).toHaveText('Borrador');
    await expect(page.getByText(`X-Road /r1/CO/GOV/${code}/consultaAfiliacion`)).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});
