import { expect, test } from '@playwright/test';
import { createApplication, publishNewApi, requestAccess, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-07: the requester attaches the exchange agreement (PDF) to a pending request, both sides
// download it with its fingerprint, and anyone can start from the country's model agreement.
// The platform admin then finds it in the register and deletes its bytes by legal order.
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
    const fileName = `acuerdo-${stamp}.pdf`;
    await createApplication(consumer, appName);
    const id = await requestAccess(consumer, name, appName);

    await expect(consumer.getByRole('heading', { name: 'Acuerdo de intercambio' })).toBeVisible();
    const template = await consumer.request.get('/files/agreement-template');
    expect(template.status()).toBe(200);
    expect(await template.text()).toContain('# Acuerdo de intercambio de datos');

    await consumer.getByLabel('Acuerdo de intercambio (PDF)').setInputFiles({
      name: fileName,
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await consumer.getByRole('button', { name: 'Adjuntar acuerdo' }).click();
    const link = consumer.getByRole('link', { name: fileName });
    await expect(link).toBeVisible();
    await expectNoAccessibilityViolations(consumer);
    const mine = await consumer.request.get((await link.getAttribute('href')) ?? '');
    expect(Buffer.from(await mine.body()).equals(PDF)).toBe(true);

    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `/requests/${id}`);
    const theirs = steward.getByRole('link', { name: fileName });
    await expect(theirs).toBeVisible();
    const download = await steward.request.get((await theirs.getAttribute('href')) ?? '');
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body()).equals(PDF)).toBe(true);
    // The provider reads it but cannot replace it.
    await expect(steward.getByRole('button', { name: 'Adjuntar acuerdo' })).toHaveCount(0);
    const href = (await theirs.getAttribute('href')) ?? '';

    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'pablo.plataforma', '/operator');
    await operator.getByRole('link', { name: 'Documentos adjuntos' }).click();
    await expect(
      operator.getByRole('heading', { level: 1, name: 'Documentos adjuntos' }),
    ).toBeVisible();
    await operator.getByLabel('Tipo').selectOption('agreement');
    await operator.getByLabel('Estado').selectOption('false');
    await operator.getByRole('button', { name: 'Aplicar filtros' }).click();
    const row = operator.getByRole('row', { name: new RegExp(fileName) });
    await expect(row).toBeVisible();
    await expectNoAccessibilityViolations(operator);

    await row.getByText(`Eliminar ${fileName}`).click();
    const form = row.getByRole('form', { name: `Eliminar ${fileName} por orden legal` });
    await form.getByLabel(/^Orden legal/).fill('Juzgado 3 Civil, auto 456 de 2026');
    // Without the confirmation nothing is deleted.
    await form.getByRole('button', { name: 'Eliminar contenido' }).click();
    await expect(
      form.getByText('Confirma que entiendes que la eliminación es definitiva.'),
    ).toBeVisible();
    await form.getByLabel(/se borra de forma definitiva/).check();
    await form.getByRole('button', { name: 'Eliminar contenido' }).click();
    await expect(operator.getByRole('row', { name: new RegExp(fileName) })).toHaveCount(0);

    await operator.goto('/operator/documents?purged=true&kind=agreement');
    const gone = operator.getByRole('row', { name: new RegExp(fileName) });
    await expect(gone.getByText('Eliminado por orden legal')).toBeVisible();
    await expect(gone.getByText(/Juzgado 3 Civil, auto 456 de 2026/)).toBeVisible();
    expect((await steward.request.get(href)).status()).toBe(410);
  });
});
