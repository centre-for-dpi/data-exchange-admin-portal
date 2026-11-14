import { expect, test } from '@playwright/test';
import { createApplication, publishNewApi, requestAccess, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-07: the requester attaches the exchange agreement (PDF) to a pending request, both sides
// download it with its fingerprint, and anyone can start from the country's model agreement.
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

test.describe('exchange agreements (M2-07)', () => {
  test('carlos attaches the agreement and lucia downloads it', async ({ browser }) => {
    test.setTimeout(300_000);
    const stamp = Date.now().toString(36);
    const { name } = await publishNewApi(browser, {
      name: `Afiliación acuerdo ${stamp}`,
      slug: `acuerdo-${stamp}`,
    });
    const consumer = await (await browser.newContext()).newPage();
    await signIn(consumer, 'carlos.dev');
    const appName = `Acuerdos ${stamp}`;
    await createApplication(consumer, appName);
    const id = await requestAccess(consumer, name, appName);

    await expect(consumer.getByRole('heading', { name: 'Acuerdo de intercambio' })).toBeVisible();
    const template = await consumer.request.get('/files/agreement-template');
    expect(template.status()).toBe(200);
    expect(await template.text()).toContain('# Acuerdo de intercambio de datos');

    await consumer.getByLabel('Acuerdo de intercambio (PDF)').setInputFiles({
      name: 'acuerdo-firmado.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await consumer.getByRole('button', { name: 'Adjuntar acuerdo' }).click();
    const link = consumer.getByRole('link', { name: 'acuerdo-firmado.pdf' });
    await expect(link).toBeVisible();
    await expectNoAccessibilityViolations(consumer);
    const mine = await consumer.request.get((await link.getAttribute('href')) ?? '');
    expect(Buffer.from(await mine.body()).equals(PDF)).toBe(true);

    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `/requests/${id}`);
    const theirs = steward.getByRole('link', { name: 'acuerdo-firmado.pdf' });
    await expect(theirs).toBeVisible();
    const download = await steward.request.get((await theirs.getAttribute('href')) ?? '');
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body()).equals(PDF)).toBe(true);
    // The provider reads it but cannot replace it.
    await expect(steward.getByRole('button', { name: 'Adjuntar acuerdo' })).toHaveCount(0);
  });
});
