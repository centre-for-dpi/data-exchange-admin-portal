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

  test('the regulator can read a review but not decide', async ({ browser }) => {
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher);
    const regulator = await (await browser.newContext()).newPage();
    await signIn(regulator, 'marta.regulador', `/operator/reviews/${versionIdOf(versionUrl)}`);
    await expect(regulator.getByText('solo el operador decide')).toBeVisible();
    await expect(regulator.getByRole('button', { name: 'Aprobar' })).toHaveCount(0);
  });
});
