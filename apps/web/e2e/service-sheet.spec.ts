import { expect, test } from '@playwright/test';
import { openCatalogApi, publishNewApi, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M4-09: the service sheet of a published version, from the catalogue, to print or save as PDF.
test.describe('printable service sheet (M4-09)', () => {
  test('a consumer opens the sheet, prints it, and saves it as PDF', async ({ browser, page }) => {
    test.setTimeout(240_000);
    const slug = `ficha-${Date.now().toString(36)}`;
    const name = `Afiliación ficha ${slug}`;
    await publishNewApi(browser, { slug, name });

    await signIn(page, 'carlos.dev', '/catalog');
    await openCatalogApi(page, name);
    await page.getByRole('link', { name: /^Ficha del servicio 1\.0/ }).click();
    const title = page.getByRole('heading', { level: 1, name: new RegExp(name) });
    await expect(title).toBeVisible();
    await expect(page.getByText(`/salud/${slug}/v1`).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'getAfiliado' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'regimen' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await expect(page.getByRole('button', { name: 'Imprimir o guardar como PDF' })).toBeVisible();

    // On paper: only the sheet, without the portal's header, footer or the button.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('body > header, header.border-b').first()).toBeHidden();
    await expect(page.getByRole('button', { name: 'Imprimir o guardar como PDF' })).toBeHidden();
    await expect(title).toBeVisible();
    // Chromium's own PDF of the page, as the browser's dialog would save it.
    const pdf = await page.pdf({ format: 'A4' });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(10_000);
  });
});
