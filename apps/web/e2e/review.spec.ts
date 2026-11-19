import { expect, test } from '@playwright/test';
import { signIn, submitNewApi, waitForValidations } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M1-04: the operator reviews a submitted version, approves it (published) or requests changes.
const versionIdOf = (url: string) => url.split('/versions/')[1]?.split(/[?#]/)[0] ?? '';

test.describe('operator review (M1-04)', () => {
  test('the operator approves a version and the provider sees it published', async ({
    browser,
  }) => {
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher);
    const versionId = versionIdOf(versionUrl);

    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', '/operator');
    await expect(operator.getByRole('heading', { name: 'Versiones en revisión' })).toBeVisible();
    await operator.locator(`a[href$="/operator/reviews/${versionId}"]`).click();
    await expect(operator.getByRole('heading', { level: 1 })).toContainText(
      'Revisión: Consulta de afiliación 1.0',
    );
    await expect(operator.getByText(/minimización/)).toBeVisible();
    await expect(operator.getByRole('cell', { name: 'regimen' })).toBeVisible();
    await expectNoAccessibilityViolations(operator);

    // The validations at submission (M4-06) go with the review, and they must pass first.
    await waitForValidations(operator);
    await expect(operator.getByTestId('version-validation')).toContainText(
      'Healthcheck a través del gateway: superada',
    );
    await expectNoAccessibilityViolations(operator);
    await operator.getByLabel('Comentario (opcional)').fill('Ficha completa.');
    await operator.getByRole('button', { name: 'Aprobar' }).click();
    await expect(operator.getByText('Esta versión ya no está en revisión.')).toBeVisible();
    await expect(operator.getByTestId('version-status')).toHaveText('Publicada');

    await publisher.goto(versionUrl);
    await expect(publisher.getByTestId('version-status')).toHaveText('Publicada');
    await expect(publisher.getByText('Ficha completa.')).toBeVisible();
    await expect(publisher.getByText('La versión está publicada.')).toBeVisible();
  });

  test('requested changes reach the provider, who fixes and resubmits', async ({ browser }) => {
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher);
    const versionId = versionIdOf(versionUrl);

    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', `/operator/reviews/${versionId}`);
    await operator.getByRole('button', { name: 'Pedir cambios' }).click();
    // The comment is required: the API's validation error is shown next to the field.
    await expect(operator.getByLabel(/^Qué debe cambiar/)).toHaveAttribute('aria-invalid', 'true');
    await operator.getByLabel(/^Qué debe cambiar/).fill('Declara el dato "estado" como personal.');
    await operator.getByRole('button', { name: 'Pedir cambios' }).click();
    await expect(operator.getByTestId('version-status')).toHaveText('Cambios solicitados');

    await publisher.goto(versionUrl);
    await expect(publisher.getByText('Declara el dato "estado" como personal.')).toBeVisible();
    await expectNoAccessibilityViolations(publisher);
    await publisher.getByRole('button', { name: 'Enviar a revisión' }).click();
    await expect(publisher.getByTestId('version-status')).toHaveText('En revisión');
  });

  test('the publisher edits what the version declares after changes are requested (R-09)', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher);
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', `/operator/reviews/${versionIdOf(versionUrl)}`);
    await operator.getByLabel(/^Qué debe cambiar/).fill('Declara también el dato "estado".');
    await operator.getByRole('button', { name: 'Pedir cambios' }).click();
    await expect(operator.getByTestId('version-status')).toHaveText('Cambios solicitados');

    // A data steward of the entity may not edit: the screen is a 404 for anyone who may not.
    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `${new URL(versionUrl).pathname}/edit`);
    await expect(steward.getByRole('heading', { level: 1 })).toHaveText('Página no encontrada');

    await publisher.goto(versionUrl);
    await publisher.getByRole('link', { name: 'Editar la versión' }).click();
    await expect(publisher.getByRole('heading', { level: 1 })).toContainText('Editar');
    // Prefilled with what the version declares.
    await expect(publisher.getByLabel('Nombre del dato')).toHaveValue('regimen');
    await expect(publisher.getByLabel('Verificación de requisitos de un trámite')).toBeChecked();
    await expect(publisher.getByLabel('Ruta del servicio en el nodo')).toHaveValue('/salud');
    await expectNoAccessibilityViolations(publisher);

    // The API's field errors show next to the field: purposes cannot be empty.
    await publisher.getByLabel('Verificación de requisitos de un trámite').uncheck();
    await publisher.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(publisher.getByRole('alert').first()).toBeVisible();
    await expect(publisher.getByText(/finalidad/i).first()).toBeVisible();

    // Fix it, declare one more data item and a legal basis, and save.
    await publisher.getByLabel('Verificación de requisitos de un trámite').check();
    await publisher.getByRole('button', { name: 'Agregar dato' }).click();
    await publisher.getByLabel('Nombre del dato').last().fill('estado');
    await publisher.getByLabel('Base legal').fill('Ley de ejemplo, artículo 5.');
    await publisher.getByRole('button', { name: 'Guardar cambios' }).click();
    await publisher.waitForURL(new RegExp(`${new URL(versionUrl).pathname}$`));
    await expect(publisher.getByTestId('version-status')).toHaveText('Cambios solicitados');
    await expect(publisher.getByRole('cell', { name: 'estado' })).toBeVisible();
    // What was saved comes back in the form.
    await publisher.getByRole('link', { name: 'Editar la versión' }).click();
    await expect(publisher.getByLabel('Base legal')).toHaveValue('Ley de ejemplo, artículo 5.');
    await expect(publisher.getByLabel('Nombre del dato')).toHaveCount(2);
    await publisher.goBack();

    await publisher.getByRole('button', { name: 'Enviar a revisión' }).click();
    await expect(publisher.getByTestId('version-status')).toHaveText('En revisión');
    // In review the version is no longer editable.
    await publisher.goto(`${versionUrl}/edit`);
    await expect(publisher.getByRole('heading', { level: 1 })).toHaveText('Página no encontrada');
  });

  test('the regulator can read a review but not decide', async ({ browser }) => {
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher);
    const regulator = await (await browser.newContext()).newPage();
    await signIn(regulator, 'marta.regulador', `/operator/reviews/${versionIdOf(versionUrl)}`);
    await expect(regulator.getByText('solo el operador decide')).toBeVisible();
    await expect(regulator.getByRole('button', { name: 'Aprobar' })).toHaveCount(0);
  });
});
