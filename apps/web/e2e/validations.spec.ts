import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
  openapiFile,
  registerApi,
  signIn,
  submitNewApi,
  waitForValidations,
  waitForValidationsToFinish,
} from './flows';
import { expectNoAccessibilityViolations } from './helpers';

/** Sets the stored validation report of a version (the e2e stack's PostgreSQL container). */
function setValidationReport(versionId: string, report: object): void {
  const result = spawnSync(
    'docker',
    ['exec', '-i', 'den-postgres-1', 'psql', '-U', 'den', '-d', 'den', '-v', 'ON_ERROR_STOP=1'],
    {
      input: `UPDATE api_version SET validation_report = '${JSON.stringify(report)}'::jsonb WHERE id = '${versionId}';`,
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('UPDATE 1');
}

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

  // P-07: a refused approval says so, approve is disabled while the validations have not passed,
  // and each failed check says what it means and what to try.
  test('approving needs passed validations, and failures say what to do (P-07)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher, {
      name: `Aprobación bloqueada ${Date.now().toString(36)}`,
    });
    await publisher.context().close();
    const versionId = versionUrl.split('/versions/')[1]?.split(/[?#]/)[0] ?? '';
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', `/operator/reviews/${versionId}`);
    await waitForValidations(operator);
    const approve = operator.getByRole('button', { name: 'Aprobar' });
    await expect(approve).toBeEnabled();

    // The validations fail after the page was loaded: the API refuses (409) and the form says so.
    const times = { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    setValidationReport(versionId, {
      status: 'failed',
      ...times,
      healthcheck: { status: 'failed', httpStatus: 504, latencyMs: 15000, reason: 'server error' },
      contract: {
        status: 'failed',
        operations: [
          {
            operation: 'GET /afiliados/{numeroIdentificacion}',
            passed: true,
            codes: [],
            receivedStatus: null,
          },
          {
            operation: 'POST /afiliados/verificaciones',
            passed: false,
            codes: ['ST101'],
            receivedStatus: 500,
          },
        ],
      },
    });
    await approve.click();
    await expect(operator.getByRole('form', { name: 'Aprobar' }).getByRole('alert')).toContainText(
      'La versión no se aprobó: sus validaciones automáticas fallaron.',
    );
    await expect(operator.getByTestId('version-status')).toHaveText('En revisión');

    // Reloaded: approve is disabled with the reason next to it, and each failure explains itself.
    await operator.reload();
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAccessibleDescription(/las validaciones automáticas fallaron/);
    await expect(operator.getByTestId('approve-blocked')).toBeVisible();
    const health = operator.getByTestId('validation-healthcheck');
    await expect(health).toContainText('El HTTP 504 lo da el gateway, no el servicio');
    await expect(health).toContainText('Qué intentar:');
    await expect(health).toContainText('Nodos del kit');
    const contract = operator.getByTestId('validation-contract');
    await expect(contract).toContainText('en esta operación: POST /afiliados/verificaciones.');
    await expect(contract).toContainText('el sandbox respondió un error del servidor');
    await expectNoAccessibilityViolations(operator);

    // Running again: still disabled, with the reason.
    setValidationReport(versionId, {
      status: 'running',
      startedAt: times.startedAt,
      finishedAt: null,
      healthcheck: null,
      contract: null,
    });
    await operator.reload();
    await expect(approve).toBeDisabled();
    await expect(operator.getByTestId('approve-blocked')).toContainText('Todavía están en curso');

    // Passed with a 404 on the service root: that is fine, and approving works.
    setValidationReport(versionId, {
      status: 'passed',
      ...times,
      healthcheck: { status: 'passed', httpStatus: 404, latencyMs: 12 },
      contract: { status: 'skipped', reason: 'no sandbox upstream', operations: [] },
    });
    await operator.reload();
    await expect(operator.getByTestId('validation-healthcheck')).toContainText(
      'El servicio respondió HTTP 404 en su raíz. Está bien',
    );
    await expect(operator.getByTestId('validation-contract')).toContainText(
      'La versión no declara sandbox',
    );
    await expect(operator.getByTestId('approve-blocked')).toHaveCount(0);
    await approve.click();
    await expect(operator.getByTestId('version-status')).toHaveText('Publicada');
    await operator.context().close();
  });
});
