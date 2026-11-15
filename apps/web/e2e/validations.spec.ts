import { expect, test } from '@playwright/test';
import { openapiFile, registerApi, signIn, waitForValidationsToFinish } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M4-06: when a version goes to review, the portal checks its service through the gateway and
// runs Schemathesis against its sandbox; the results go with the review.
test.describe('validations at submission (M4-06)', () => {
  test('a version with a sandbox gets a healthcheck and a contract test', async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'pedro.publicador', '/my-apis');
    const slug = `contrato-${Date.now().toString(36)}`;
    await registerApi(page, slug, `Afiliación con sandbox ${slug}`);
    await page.getByRole('link', { name: 'Nueva versión' }).click();
    await page.getByLabel(/^Versión/).fill('1.0');
    await page.getByLabel('Archivo OpenAPI (YAML o JSON)').setInputFiles(openapiFile);
    await page.getByLabel('Ruta del servicio en el nodo').fill('/salud');
    await page.getByLabel('En un nodo').check();
    await page.getByLabel(/^Ruta del servicio de pruebas/).fill('/salud');
    await page.getByLabel('Verificación de requisitos de un trámite').check();
    await page.getByLabel('Nombre del dato').fill('regimen');
    await page.getByRole('button', { name: 'Crear versión' }).click();
    await page.getByRole('button', { name: 'Enviar a revisión' }).click();
    await expect(page.getByTestId('version-status')).toHaveText('En revisión');
    const versionId = page.url().split('/versions/')[1]?.split(/[?#]/)[0] ?? '';

    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', `/operator/reviews/${versionId}`);
    await waitForValidationsToFinish(operator);
    const results = operator.getByTestId('version-validation');
    await expect(results).toContainText('Healthcheck a través del gateway: superada');
    // Schemathesis tested both operations of the sandbox, through the gateway.
    await expect(results).toContainText('Prueba de contrato en el sandbox:');
    await expect(results).toContainText('GET /afiliados/{numeroIdentificacion}');
    await expect(results).toContainText('POST /afiliados/verificaciones');
    await expectNoAccessibilityViolations(operator);

    // The provider can run them again.
    await page.reload();
    await page.getByRole('button', { name: 'Repetir validaciones' }).click();
    await expect(page.getByTestId('version-validation')).toContainText('En curso');
  });
});
