import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M4-07: the entity admin confirms the bootcamp prerequisites; the operator sees each entity's
// readiness. The designees item comes from the members (salud has a publisher and a steward).
test.describe('bootcamp readiness (M4-07)', () => {
  test('elena confirms the prerequisites and the operator sees salud ready', async ({
    browser,
  }) => {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'elena.admin', '/my-entity/bootcamp');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Preparación del bootcamp' }),
    ).toBeVisible();
    await expect(page.getByTestId('bootcamp-designees')).toContainText('Listo');
    await expectNoAccessibilityViolations(page);

    for (const [item, title] of [
      ['server', 'Servidor para el nodo'],
      ['readonly_user', 'Usuario de solo lectura'],
      ['outbound_443', 'Salida a internet por 443'],
      ['use_case', 'Caso de uso'],
    ] as const) {
      const card = page.getByTestId(`bootcamp-${item}`);
      await card.getByLabel(`${title}: listo`).check();
      if (item === 'use_case') {
        await card
          .getByLabel(/^Nota para el operador/)
          .fill('Afiliación para subsidios de vivienda');
        // The manual steps the use case avoids count in the network's indicators (M5-04).
        await card.getByLabel(/^Pasos manuales que evita/).fill('3');
      }
      await card.getByRole('button', { name: 'Guardar' }).click();
      await expect(card).toContainText('Listo');
    }
    await expect(page.getByText('La entidad está lista para el bootcamp.')).toBeVisible();

    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', '/operator/bootcamp');
    await expect(operator.getByRole('row', { name: /Salud \(ficticia\)/ })).toContainText('5 de 5');
    await expectNoAccessibilityViolations(operator);
  });
});
