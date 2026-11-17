import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './flows';
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

// M5-07: the operator's sync console: state, drift and a manual retry.
test.describe("the operator's sync console (M5-07)", () => {
  const versionId = randomUUID();
  const target = `apisix:route:den-route-${versionId}`;
  test.beforeAll(() => {
    sql(
      `INSERT INTO sync_state (target, system, desired_hash, applied_hash, status, last_error, attempts, drift_detected_at, drift_count, updated_at)
       VALUES ('${target}', 'apisix', 'h2', 'h1', 'error', 'APISIX PUT routes failed: 503', 3, now(), 1, now());`,
    );
  });
  test.afterAll(() => {
    sql(`DELETE FROM sync_state WHERE target = '${target}';`);
  });

  test('the platform admin finds an object in error and retries it', async ({ page }) => {
    await signIn(page, 'pablo.plataforma', '/operator');
    await page.getByRole('link', { name: 'Sincronización del gateway' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sincronización del gateway' }),
    ).toBeVisible();
    await expect(page.getByText(/se encontró y se corrigió deriva/)).toBeVisible();
    await page.getByLabel('Buscar en el objeto').fill(versionId);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForURL(/q=/);
    const row = page.getByRole('row', { name: new RegExp(versionId) });
    await expect(row).toContainText('Con error');
    await expect(row).toContainText('APISIX PUT routes failed: 503');
    await expect(row).toContainText('3 intentos');
    await expectNoAccessibilityViolations(page);
    await row.getByRole('button', { name: `Reintentar la sincronización de ${target}` }).click();
    await expect(row.getByRole('status')).toHaveText('En cola');
  });

  test('the reviewer sees the console without the retry', async ({ page }) => {
    await signIn(page, 'ana.operadora', `/operator/sync?q=${versionId}`);
    await expect(page.getByRole('row', { name: new RegExp(versionId) })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Reintentar/ })).toHaveCount(0);
  });
});
