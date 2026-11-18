import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { openapiFile, registerApi, signIn, submitNewApi } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

/** SQL on the development database (the e2e stack's PostgreSQL container). */
function sql(statement: string): void {
  const result = spawnSync(
    'docker',
    ['exec', '-i', 'den-postgres-1', 'psql', '-U', 'den', '-d', 'den', '-v', 'ON_ERROR_STOP=1'],
    { input: statement, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}

// co.yaml accepts the node and X-Road (features.upstreams); X-Road only where the API runs with
// the operator's Security Server (DEN_XROAD_*), which the development .env leaves out.
const xroad = Boolean(
  process.env.DEN_XROAD_SECURITY_SERVER_URL?.trim() && process.env.DEN_XROAD_CLIENT?.trim(),
);

// P-04: providers come in through the node; the form offers only what the deployment accepts, and
// a version on a channel no longer accepted keeps working and is flagged to the operator.
test.describe('upstream types per country (P-04)', () => {
  test('the version form offers only the accepted types', async ({ page }) => {
    await signIn(page, 'pedro.publicador', '/my-apis');
    const slug = `canal-${Date.now().toString(36)}`;
    await registerApi(page, slug, `Afiliación por el nodo ${slug}`);
    await page.getByRole('link', { name: 'Nueva versión' }).click();
    await page.getByLabel(/^Versión/).fill('1.0');
    await page.getByLabel('Archivo OpenAPI (YAML o JSON)').setInputFiles(openapiFile);

    // Never the public API without a node: co.yaml does not opt in, as upstream or sandbox.
    await expect(page.getByLabel('API pública de la entidad (HTTPS, sin nodo)')).toHaveCount(0);
    await expect(page.getByLabel('API pública (HTTPS, sin nodo)')).toHaveCount(0);
    await expect(page.getByLabel('En un nodo')).toBeVisible();
    if (xroad) {
      // Several: the form asks, the node first.
      await expect(
        page.getByRole('group', { name: '¿Por dónde llega el servicio?' }),
      ).toBeVisible();
      await expect(
        page.getByLabel('Nodo de la entidad (API propia o API instantánea)'),
      ).toBeChecked();
      await expect(page.getByLabel('Servicio en X-Road')).toBeVisible();
      await expect(page.getByTestId('upstream-only')).toHaveCount(0);
    } else {
      // The node only: no question, only the node and the service path.
      await expect(page.getByRole('group', { name: '¿Por dónde llega el servicio?' })).toHaveCount(
        0,
      );
      await expect(page.getByLabel('Servicio en X-Road')).toHaveCount(0);
      await expect(page.getByTestId('upstream-only')).toContainText(
        'El servicio llega por el nodo de la entidad',
      );
    }
    await expect(page.getByLabel('Nodo del kit', { exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('Ruta del servicio en el nodo').fill('/salud');
    await page.getByLabel('Verificación de requisitos de un trámite').check();
    await page.getByLabel('Nombre del dato').fill('regimen');
    await page.getByRole('button', { name: 'Crear versión' }).click();
    await expect(page.getByTestId('version-status')).toHaveText('Borrador');
    await expect(page.getByTestId('upstream-disallowed')).toHaveCount(0);
  });

  test('a version on a channel no longer accepted is flagged to the operator', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await (await browser.newContext()).newPage();
    const name = `Afiliación sin nodo ${Date.now().toString(36)}`;
    const { versionUrl } = await submitNewApi(page, { name });
    const versionId = versionUrl.split('/versions/')[1]?.split(/[?#]/)[0] ?? '';
    // Registered when the country still accepted direct upstreams (as a pilot deployment may have).
    sql(
      `UPDATE api_version SET upstream_type = 'direct',
         upstream = '{"type":"direct","url":"https://api.salud.example.org/v1","mtls":false}'::jsonb
       WHERE id = '${versionId}';`,
    );
    try {
      await page.reload();
      await expect(page.getByTestId('upstream-disallowed')).toContainText(
        'Esta red ya no acepta versiones nuevas con API pública sin nodo',
      );
      await page.context().close();

      const operator = await (await browser.newContext()).newPage();
      await signIn(operator, 'pablo.plataforma', '/operator/sync');
      const flagged = operator.getByTestId('disallowed-upstreams');
      await expect(
        operator.getByRole('heading', { name: 'Versiones con un canal que ya no se acepta' }),
      ).toBeVisible();
      const row = flagged.getByRole('row').filter({ hasText: name });
      await expect(row).toContainText('En revisión');
      await expect(row).toContainText('API pública sin nodo');
      await expectNoAccessibilityViolations(operator);

      await row.getByRole('link', { name: `${name} 1.0` }).click();
      await expect(operator.getByTestId('upstream-disallowed')).toContainText(
        'el operador decide qué hacer con ella',
      );
      await expectNoAccessibilityViolations(operator);
      await operator.context().close();
    } finally {
      sql(
        `UPDATE api_version SET upstream_type = 'node',
           upstream = '{"type":"node","servicePath":"/salud"}'::jsonb
         WHERE id = '${versionId}';`,
      );
    }
  });
});
