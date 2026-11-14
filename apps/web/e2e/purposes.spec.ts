import { expect, test } from '@playwright/test';
import { signIn, submitNewApi } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-10: the operator manages the purpose catalogue; the data steward chooses, among active
// purposes, those a version allows.
const versionIdOf = (url: string) => url.split('/versions/')[1]?.split(/[?#]/)[0] ?? '';

test.describe('purpose catalogue (M2-10)', () => {
  test('ana adds a purpose, lucia allows it on a version, ana deactivates it', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const stamp = Date.now().toString(36).replace(/[0-9]/g, 'x');
    const code = `prueba_${stamp}`;
    const name = `Prueba de catálogo ${stamp}`;

    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', '/operator/purposes');
    await expect(
      operator.getByRole('heading', { level: 1, name: 'Catálogo de finalidades' }),
    ).toBeVisible();
    const create = operator.getByRole('form', { name: 'Agregar una finalidad' });
    await create.getByLabel(/^Código/).fill(code);
    await create.getByLabel(/^Nombre en español/).fill(name);
    await create.getByLabel(/^Nombre en inglés/).fill(`Catalogue test ${stamp}`);
    await create
      .getByLabel(/^Descripción en español/)
      .fill('Finalidad creada por la prueba de punta a punta.');
    await create
      .getByLabel(/^Descripción en inglés/)
      .fill('Purpose created by the end-to-end test.');
    await create.getByRole('button', { name: 'Agregar una finalidad' }).click();
    await expect(operator.getByRole('button', { name: `Desactivar ${code}` })).toBeVisible();
    await expectNoAccessibilityViolations(operator);

    // pedro submits a version, ana approves it; lucia allows the new purpose on it.
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher, {
      name: `Afiliación fin ${stamp}`,
      slug: `fin-${stamp}`,
    });
    await operator.goto(`/operator/reviews/${versionIdOf(versionUrl)}`);
    await operator.getByRole('button', { name: 'Aprobar' }).click();
    await expect(operator.getByTestId('version-status')).toHaveText('Publicada');

    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', new URL(versionUrl).pathname);
    await expect(steward.getByRole('heading', { name: 'Finalidades permitidas' })).toBeVisible();
    await steward.getByLabel(name).check();
    await steward.getByRole('button', { name: 'Guardar finalidades' }).click();
    await expect(steward.getByText('Finalidades guardadas.')).toBeVisible();
    await expectNoAccessibilityViolations(steward);

    // ana deactivates it: it is no longer offered.
    await operator.goto('/operator/purposes');
    await operator.getByRole('button', { name: `Desactivar ${code}` }).click();
    await expect(operator.getByRole('button', { name: `Reactivar ${code}` })).toBeVisible();
    await steward.reload();
    await expect(steward.getByLabel(name)).toHaveCount(0);
  });
});
