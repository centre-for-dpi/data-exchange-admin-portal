import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { newVersion, openapiFile, registerApi, signInAsPublisher } from './flows';
import { expectNoAccessibilityViolations, keycloakLogin } from './helpers';

// M1-03: the API publisher registers an API and a version, sees the lint and submits it.
test.describe('API registration (M1-03)', () => {
  test('a publisher registers an API, uploads its OpenAPI and sends it to review', async ({
    page,
  }) => {
    await signInAsPublisher(page);
    await expectNoAccessibilityViolations(page);
    await registerApi(page, `afiliacion-${Date.now().toString(36)}`);

    await page.getByRole('link', { name: 'Nueva versión' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Nueva versión de');
    await expectNoAccessibilityViolations(page);
    await page.goBack();

    await newVersion(page, { version: '1.0', file: openapiFile });
    await expect(page.getByTestId('version-status')).toHaveText('Borrador');
    await expect(page.getByText('El documento cumple las reglas de la red.')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'getAfiliado' })).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Parámetro numeroIdentificacion (CC)' }),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: 'regimen' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByRole('button', { name: 'Enviar a revisión' }).click();
    await expect(page.getByTestId('version-status')).toHaveText('En revisión');
    await expect(
      page.getByRole('status').filter({ hasText: 'revisión del operador' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar a revisión' })).toHaveCount(0);
  });

  test('lint errors show their line and block the submission until the document is fixed', async ({
    page,
  }) => {
    await signInAsPublisher(page);
    await registerApi(page, `afiliacion-${Date.now().toString(36)}`);
    const broken = readFileSync(openapiFile, 'utf8').replace(
      '      operationId: getAfiliado\n',
      '',
    );
    await newVersion(page, { version: '1.0', text: broken });

    await expect(page.getByText(/El documento tiene 1 error/)).toBeVisible();
    await expect(page.getByText(/^Línea \d+:/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar a revisión' })).toBeDisabled();
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('Archivo OpenAPI (YAML o JSON)').setInputFiles(openapiFile);
    await page.getByRole('button', { name: 'Subir y validar' }).click();
    await expect(page.getByText('El documento cumple las reglas de la red.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar a revisión' })).toBeEnabled();
  });

  test('form errors from the API are announced and shown next to each field', async ({ page }) => {
    await signInAsPublisher(page);
    await page.getByRole('link', { name: 'Registrar API' }).click();
    await page.getByLabel('Identificador en la URL').fill('NO VALE');
    await page.getByRole('button', { name: 'Registrar API' }).click();

    // The form's error summary (Next.js adds its own role=alert route announcer elsewhere).
    const summary = page.locator('form').getByRole('alert');
    await expect(summary).toBeFocused();
    await expect(page.getByLabel('Identificador en la URL')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expectNoAccessibilityViolations(page);
  });

  test('a member without the publisher role can read but not register', async ({ page }) => {
    await page.goto('/my-apis');
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await keycloakLogin(page, 'lucia.datos');
    await page.goto('/my-apis');
    await expect(page.getByRole('link', { name: 'Registrar API' })).toHaveCount(0);
    await expect(page.getByText(/Solo quien tiene el rol de publicador/)).toBeVisible();
  });
});
