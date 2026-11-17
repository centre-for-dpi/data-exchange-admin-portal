import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-09: an auditor filters the network trail, exports what is filtered with its signed
// SHA-256, and the chain check reports the daily anchors.
test.describe('complete audit (M2-09)', () => {
  test('sofia filters, exports a signed CSV and verifies chain and anchors', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'sofia.auditora', '/audit');
    await expect(page.getByRole('heading', { name: 'Filtrar la bitácora' })).toBeVisible();
    await page.getByLabel('Acción o área (p. ej. subscription)').fill('subscription');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await page.waitForURL(/action=subscription/);
    await expectNoAccessibilityViolations(page);

    const href = (await page.getByRole('link', { name: 'CSV' }).getAttribute('href')) ?? '';
    expect(href).toContain('action=subscription');
    const res = await page.request.get(href);
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(res.headers()['x-den-export-sha256']).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
    expect(res.headers()['x-den-export-signature']).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const rows = body.toString('utf8').trim().split('\r\n').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.includes('"subscription.'))).toBe(true);

    await page.getByRole('button', { name: 'Verificar integridad' }).click();
    await expect(page.getByTestId('chain-check')).toContainText(/anclaje/);
  });
});
