import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

const repoRoot = resolve(import.meta.dirname, '../../..');
const TAG = `e2em5${Date.now().toString(36)}`;
const MONTH = { from: '2025-10-01', to: '2025-10-31' };

/** The synthetic traffic generator (pnpm traffic:simulate), on a month and a tag of its own. */
function simulate(...args: string[]) {
  const result = spawnSync('pnpm', ['-s', 'traffic:simulate', ...args, '--tag', TAG], {
    cwd: repoRoot,
    encoding: 'utf8',
    // pnpm is a .cmd on Windows; the arguments are fixed strings of this test.
    shell: true,
    timeout: 600_000,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return `${result.stdout}${result.stderr}`;
}

const percent = (text: string) =>
  Number(/(\d+(?:[.,]\d+)?)\s?%/.exec(text)?.[1]?.replace(',', '.'));

// Closing of M5: the regulator sees the indicators of a simulated month (synthetic traffic of
// the network's active subscriptions), and the provider and the consumer their usage.
test.describe('closing of M5: a simulated month', () => {
  test.beforeAll(() => {
    test.setTimeout(600_000);
    const out = simulate('--from', MONTH.from, '--days', '31', '--scale', '0.2', '--seed', '11');
    expect(out).toMatch(/Synthetic traffic: \d+ calls/);
  });
  test.afterAll(() => {
    simulate('--clear');
  });

  test('the regulator sees the indicators of the month', async ({ page }) => {
    await signIn(
      page,
      'marta.regulador',
      `/regulator/indicators?from=${MONTH.from}&to=${MONTH.to}`,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Indicadores de la red' }),
    ).toBeVisible();
    const stat = (label: string) =>
      page.locator('.usage-stats').getByText(label, { exact: true }).locator('..');
    // Mostly 2xx: the synthetic month refuses and fails a little, as a real one would.
    const successful = percent((await stat('Consultas exitosas').textContent()) ?? '');
    expect(successful).toBeGreaterThan(90);
    expect(successful).toBeLessThan(100);
    await expect(stat('APIs con consumo real')).toContainText(/[1-9]\d* de \d+/);
    await expect(
      page
        .getByRole('region', { name: 'Negadas por el gateway, por razón' })
        .getByRole('row', { name: /Finalidad no aprobada/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'APIs con consumo real en el periodo' }).getByRole('row'),
    ).not.toHaveCount(1);
    await expectNoAccessibilityViolations(page);

    // Who exchanged with whom that month.
    await page.getByRole('link', { name: 'Mapa de intercambios' }).click();
    await page.waitForURL(/exchange-map/);
    await page.getByLabel('Desde').fill(MONTH.from);
    await page.getByLabel('Hasta').fill(MONTH.to);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForURL(/exchange-map\?from=2025-10-01/);
    await expect(
      page.getByRole('region', { name: 'Intercambios' }).getByRole('row', {
        name: /Programas Sociales.*Salud/,
      }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });

  test('the provider and the consumer see their usage of the month', async ({ browser }) => {
    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `/my-apis/usage?from=${MONTH.from}&to=${MONTH.to}`);
    const calls = steward
      .locator('.usage-stats')
      .getByText('Llamadas', { exact: true })
      .locator('..');
    await expect(calls).not.toContainText(/^Llamadas0$/);
    await expect(
      steward.getByRole('region', { name: 'Por entidad consumidora' }).getByRole('row', {
        name: /Programas Sociales/,
      }),
    ).toBeVisible();

    const developer = await (await browser.newContext()).newPage();
    await signIn(developer, 'carlos.dev', `/my-apps/usage?from=${MONTH.from}&to=${MONTH.to}`);
    await expect(
      developer.getByRole('region', { name: 'Llamadas negadas por el gateway, con su razón' }),
    ).toContainText(/Finalidad no aprobada|Límite de peticiones|Falta X-RID-End-User/);
  });
});
