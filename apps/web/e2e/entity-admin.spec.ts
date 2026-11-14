import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-11: the platform admin suspends an entity (also as provider) and reactivates it.
test.describe('suspension of entities (M2-11)', () => {
  test('pablo suspends and reactivates an entity from the console', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'pablo.plataforma', '/operator/entities');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Entidades de la red' }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);

    const row = page.getByRole('row', { name: /socioeconomico/ });
    const manage = row.getByText(/^Gestionar /);
    // A run interrupted before reactivating leaves it suspended: start from active.
    if ((await row.getByText('Suspendida').count()) > 0) {
      await manage.click();
      await row
        .getByRole('form', { name: /^Reactivar / })
        .getByRole('button', { name: 'Reactivar' })
        .click();
      await expect(row.getByText('Activa', { exact: true })).toBeVisible();
    }

    if (!(await row.getByRole('form', { name: /^Suspender / }).isVisible())) await manage.click();
    const suspend = row.getByRole('form', { name: /^Suspender / });
    await suspend.getByLabel(/^Motivo/).fill('Revisión del uso de los datos por el regulador.');
    await suspend.getByLabel('Dejar de servir también sus APIs a otras entidades').check();
    await suspend.getByRole('button', { name: 'Suspender' }).click();
    await expect(row.getByText('Suspendida')).toBeVisible();
    await expect(row.getByText('También como proveedora')).toBeVisible();

    if (!(await row.getByRole('form', { name: /^Reactivar / }).isVisible())) await manage.click();
    await row
      .getByRole('form', { name: /^Reactivar / })
      .getByRole('button', { name: 'Reactivar' })
      .click();
    await expect(row.getByText('Activa', { exact: true })).toBeVisible();
  });
});
