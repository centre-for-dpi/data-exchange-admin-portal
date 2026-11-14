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

  test('pablo registers an entity directly, without a request', async ({ browser }) => {
    test.setTimeout(180_000);
    const id = Date.now().toString(36);
    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'pablo.plataforma', '/operator/entities');
    await page.getByRole('link', { name: 'Registrar entidad' }).click();
    await page.waitForURL(/\/operator\/entities\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Registrar entidad' })).toBeVisible();

    const legalName = `Instituto Directo ${id}`;
    await page.getByLabel('Nombre legal').fill(legalName);
    await page.getByLabel('Nombre corto').fill(`Directo ${id}`);
    // An identifier another entity already holds: the error keeps what was typed.
    await page.locator('[name="slug"]').fill('salud');
    await page.getByLabel('Número de identificación').fill(`901${id}`);
    await page.getByLabel('Correo de contacto de la entidad').fill(`contacto.${id}@example.org`);
    await page.locator('[name="dpoName"]').fill('Dora Protección');
    await page.locator('[name="dpoEmail"]').fill(`dpo.${id}@example.org`);
    for (const role of ['data_steward', 'technical_lead']) {
      await page.locator(`[name="designees.${role}.fullName"]`).fill(`Persona ${role}`);
      await page.locator(`[name="designees.${role}.email"]`).fill(`${role}.${id}@example.org`);
    }
    await page.locator('[name="admin.fullName"]').fill('Andrea Administradora');
    await page.locator('[name="admin.email"]').fill(`admin.${id}@example.org`);
    await page
      .getByLabel(/^Acto o decisión que fundamenta el alta/)
      .fill('Decreto 123 de 2026, artículo 4.');
    await expectNoAccessibilityViolations(page);
    await page.getByRole('button', { name: 'Registrar entidad' }).click();
    await expect(page.getByText('Another entity already uses this identifier')).toBeVisible();
    await expect(page.getByLabel('Nombre legal')).toHaveValue(legalName);
    await expect(page.locator('[name="admin.email"]')).toHaveValue(`admin.${id}@example.org`);

    await page.locator('[name="slug"]').fill(`directo-${id}`);
    await page.getByRole('button', { name: 'Registrar entidad' }).click();
    await page.waitForURL(/\/operator\/entities$/, { timeout: 30_000 });
    const row = page.getByRole('row', { name: new RegExp(`directo-${id}`) });
    await expect(row.getByText('Activa', { exact: true })).toBeVisible();
  });
});
