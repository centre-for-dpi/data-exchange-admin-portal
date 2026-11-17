import { expect, test } from '@playwright/test';
import { dropIndex, indexAccessLogs, publishedIds } from './access-logs';
import { createApplication, publishNewApi, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M5-02: usage of the entity's APIs for the provider, from the access logs.
test.describe('usage of my APIs (M5-02)', () => {
  const index = `den-access-e2e-usage-${Date.now().toString(36)}`;
  test.afterAll(async () => {
    await dropIndex(index);
  });

  test('the data steward sees who calls the API, for what and how it answers', async ({
    browser,
    page,
  }) => {
    test.setTimeout(300_000);
    const slug = `uso-${Date.now().toString(36)}`;
    const name = `Afiliación uso ${slug}`;
    await publishNewApi(browser, { slug, name });
    await signIn(page, 'lucia.datos', '/catalog');
    const { apiId, versionId } = await publishedIds(page, name);
    const route = `den-route-${versionId}`;
    const ok = {
      route_id: route,
      status: 200,
      operation: 'getAfiliado',
      purpose: 'eligibility_check',
    };
    await indexAccessLogs(index, [
      { ...ok, ts: '2026-03-02T14:00:00Z', consumer_entity: 'programas-sociales', latency_ms: 10 },
      { ...ok, ts: '2026-03-02T15:00:00Z', consumer_entity: 'programas-sociales', latency_ms: 20 },
      { ...ok, ts: '2026-03-03T14:00:00Z', consumer_entity: 'programas-sociales', latency_ms: 30 },
      {
        route_id: route,
        ts: '2026-03-03T15:00:00Z',
        status: 403,
        consumer_entity: 'programas-sociales',
        purpose: 'benefit_targeting',
        deny_reason: 'purpose_not_allowed',
        latency_ms: 2,
      },
    ]);

    await page.goto('/my-apis');
    await page.getByRole('link', { name: 'Ver el uso' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Uso de mis APIs' })).toBeVisible();
    // The period and the API, in the filters row.
    await page.getByLabel('Desde').fill('2026-03-02');
    await page.getByLabel('Hasta').fill('2026-03-03');
    await page.getByLabel('API', { exact: true }).selectOption(apiId);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForURL(/from=2026-03-02/);

    const stats = page.locator('.usage-stats');
    await expect(stats.getByText('Llamadas', { exact: true }).locator('..')).toContainText('4');
    await expect(stats.getByText('Negadas por el gateway').locator('..')).toContainText('1');
    const section = (title: string) => page.getByRole('region', { name: title });
    await expect(
      section('Por entidad consumidora').getByRole('row', { name: /Programas Sociales/ }),
    ).toContainText('4');
    const byPurpose = section('Por finalidad');
    await expect(byPurpose.getByRole('row', { name: /Verificación de requisitos/ })).toContainText(
      '3',
    );
    const byOperation = section('Por operación');
    await expect(byOperation.getByRole('row', { name: /getAfiliado/ })).toContainText('3');
    const byStatus = section('Por código de respuesta');
    await expect(byStatus.getByRole('row', { name: /403/ })).toContainText('1');
    await expectNoAccessibilityViolations(page);

    // The chart: each day is reachable with the keyboard and says its values.
    const day = page.getByRole('img', { name: /: 2 llamadas/ }).first();
    await day.focus();
    await expect(page.locator('.usage-chart-tooltip')).toContainText('2');
    // Every value also without hovering, in the table view.
    await page.getByText('Ver los datos como tabla').click();
    const table = page.locator('.usage-chart table');
    await expect(table.getByRole('row')).toHaveCount(3);
  });

  test('a developer of a consumer entity does not see it', async ({ page }) => {
    await signIn(page, 'carlos.dev', '/my-apis/usage');
    await expect(
      page.getByText('El uso de las APIs lo ven quienes administran, publican o responden'),
    ).toBeVisible();
  });
});

// M5-03: usage of the entity's applications for the consumer, with the gateway's refusals.
test.describe('usage of my applications (M5-03)', () => {
  const index = `den-access-e2e-consumed-${Date.now().toString(36)}`;
  test.afterAll(async () => {
    await dropIndex(index);
  });

  test('the developer sees the calls of the application and why some were denied', async ({
    browser,
    page,
  }) => {
    test.setTimeout(300_000);
    const slug = `consumo-${Date.now().toString(36)}`;
    const name = `Afiliación consumo ${slug}`;
    await publishNewApi(browser, { slug, name });
    await signIn(page, 'carlos.dev', '/catalog');
    const { versionId } = await publishedIds(page, name);
    const appName = `Consumo ${slug}`;
    const clientId = await createApplication(page, appName);
    const route = `den-route-${versionId}`;
    const base = { route_id: route, consumer_app: clientId, consumer_entity: 'programas-sociales' };
    await indexAccessLogs(index, [
      { ...base, ts: '2026-04-10T15:00:00Z', status: 200, latency_ms: 10 },
      { ...base, ts: '2026-04-10T16:00:00Z', status: 200, latency_ms: 12 },
      { ...base, ts: '2026-04-10T17:00:00Z', status: 403, deny_reason: 'purpose_not_allowed' },
      { ...base, ts: '2026-04-10T18:00:00Z', status: 429, deny_reason: 'rate_limited' },
    ]);

    await page.goto('/my-apps');
    await page.getByRole('link', { name: 'Ver el uso' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Uso de mis aplicaciones' }),
    ).toBeVisible();
    await page.getByLabel('Desde').fill('2026-04-10');
    await page.getByLabel('Hasta').fill('2026-04-10');
    await page.getByLabel('Aplicación', { exact: true }).selectOption({ label: appName });
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForURL(/applicationId=/);

    const section = (title: string) => page.getByRole('region', { name: title });
    await expect(
      section('Por aplicación').getByRole('row', { name: new RegExp(appName) }),
    ).toContainText('4');
    await expect(section('Por API').getByRole('row', { name: new RegExp(name) })).toContainText(
      'Salud',
    );
    const denials = section('Llamadas negadas por el gateway, con su razón');
    await expect(
      denials.getByRole('row', { name: /Finalidad no aprobada para la suscripción/ }),
    ).toContainText('purpose_not_allowed');
    await expect(
      denials.getByRole('row', { name: /Límite de peticiones por minuto superado/ }),
    ).toContainText('1');
    await expectNoAccessibilityViolations(page);
  });
});
