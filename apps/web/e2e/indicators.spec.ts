import { expect, test } from '@playwright/test';
import { publishNewApi, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';
import { dropIndex, indexAccessLogs, publishedIds } from './access-logs';

// M5-04: the network's indicators for the regulator and the operator.
test.describe("the network's indicators (M5-04)", () => {
  const index = `rid-access-e2e-indicators-${Date.now().toString(36)}`;
  test.afterAll(async () => {
    await dropIndex(index);
  });

  test('the regulator sees successful calls, APIs in use and the connected entities', async ({
    browser,
    page,
  }) => {
    test.setTimeout(300_000);
    const slug = `indicador-${Date.now().toString(36)}`;
    const name = `Afiliación indicadores ${slug}`;
    await publishNewApi(browser, { slug, name });
    await signIn(page, 'marta.regulador', '/catalog');
    const { versionId } = await publishedIds(page, name);
    // July 2025: no other traffic in the store for that month.
    const call = (ts: string, status: number, extra: Record<string, unknown> = {}) => ({
      route_id: `rid-route-${versionId}`,
      ts,
      status,
      latency_ms: 10,
      ...extra,
    });
    await indexAccessLogs(index, [
      call('2025-07-02T15:00:00Z', 200),
      call('2025-07-03T15:00:00Z', 200),
      call('2025-07-04T15:00:00Z', 200),
      call('2025-07-05T15:00:00Z', 500),
      call('2025-07-06T15:00:00Z', 403, { deny_reason: 'subscription_expired' }),
    ]);

    await page.goto('/regulator');
    await page.getByRole('link', { name: 'Indicadores de la red' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Indicadores de la red' }),
    ).toBeVisible();
    await page.getByLabel('Desde').fill('2025-07-01');
    await page.getByLabel('Hasta').fill('2025-07-31');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForURL(/from=2025-07-01/);

    const stats = page.locator('.usage-stats');
    // 3 of 4: the authorization refusal is reported apart.
    await expect(stats.getByText('Consultas exitosas').locator('..')).toContainText('75');
    await expect(stats.getByText('APIs con consumo real').locator('..')).toContainText('1 de');
    await expect(
      page.getByRole('region', { name: 'APIs con consumo real en el periodo' }).getByRole('row', {
        name: new RegExp(name),
      }),
    ).toContainText('3');
    await expect(
      page
        .getByRole('region', { name: 'Negadas por el gateway, por razón' })
        .getByRole('row', { name: /Suscripción vencida/ }),
    ).toContainText('1');
    await expect(page.getByText(/Entidades conectadas por mes/)).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });

  test('a developer does not get them', async ({ page }) => {
    await signIn(page, 'carlos.dev', '/');
    const res = await page.goto('/regulator/indicators');
    expect(res?.status()).toBe(404);
  });
});
