import { expect, test } from '@playwright/test';
import { publishNewApi, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M1-05: consumers discover published APIs and read their service sheet and documentation.
test.describe('catalogue (M1-05)', () => {
  test('a consumer finds a published API and reads its sheet and documentation', async ({
    browser,
    page,
  }) => {
    const unique = `Afiliación ${Date.now().toString(36)}`;
    const { slug } = await publishNewApi(browser, { name: unique });

    // Nothing may be loaded from third-party hosts (Scalar fonts, telemetry, CDNs).
    const external = new Set<string>();
    page.on('request', (request) => {
      const host = new URL(request.url()).hostname;
      if (!['localhost', '127.0.0.1'].includes(host)) external.add(host);
    });

    await signIn(page, 'carlos.dev', '/catalog');
    await page.getByLabel('Buscar por nombre, resumen o etiqueta').fill(unique);
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page.getByRole('status')).toHaveText('1 API encontrada');
    const card = page.getByRole('listitem').filter({ hasText: unique });
    await expect(card).toContainText('Publicada por Salud (ficticia)');
    await expect(card).toContainText('Datos personales: regimen');
    await expectNoAccessibilityViolations(page);

    // A filter that excludes it.
    await page.getByLabel('Clasificación').selectOption({ label: 'Pública' });
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page.getByRole('status')).toHaveText('No hay APIs que coincidan con la búsqueda.');

    await page.getByLabel('Clasificación').selectOption({ label: 'Todas' });
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await page.getByRole('link', { name: unique }).click();

    await expect(page.getByRole('heading', { level: 1, name: unique })).toBeVisible();
    // The service sheet (the Scalar documentation repeats some of it from the OpenAPI document).
    const main = page.locator('#main-content');
    await expect(main.locator('dl').first()).toContainText('Entidad de Salud (ficticia)');
    await expect(main.locator('dl').nth(1)).toContainText(`http://localhost:9080/salud/${slug}/v1`);
    await expect(main.locator('dl').nth(1)).toContainText(
      'Verificación de requisitos de un trámite',
    );
    // Where the data subject of each operation is (ADR-0015).
    await expect(
      main.getByRole('cell', { name: 'Parámetro numeroIdentificacion (CC)' }),
    ).toBeVisible();
    await expect(
      main.getByRole('cell', { name: 'Cabecera X-RID-Data-Subject (CC)' }),
    ).toBeVisible();
    // Scalar renders the operations of the OpenAPI document, read-only.
    await expect(page.getByText('Consultar afiliación').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Test Request/i })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    expect([...external]).toEqual([]);
  });

  test('anonymous visitors are asked to sign in when the catalogue is not public', async ({
    page,
  }) => {
    await page.goto('/catalog');
    await expect(
      page.getByText('Inicia sesión para ver el catálogo de APIs de la red.'),
    ).toBeVisible();
  });
});
