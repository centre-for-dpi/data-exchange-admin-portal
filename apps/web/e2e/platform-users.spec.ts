import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';
import { newPerson, registerAccount } from './onboarding';

// M-03: the platform administrator grants and revokes platform roles and disables accounts from
// the operator console, with a reason that goes into the audit trail.
test.describe('platform roles and accounts (M-03)', () => {
  test('pablo grants and revokes a role and disables and enables an account', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const id = randomUUID().slice(0, 8);
    const person = newPerson('rol', id);
    const name = `${person.firstName} ${person.lastName}`;

    // The person registers and signs in once: only then does the portal know them.
    const registered = await (await browser.newContext()).newPage();
    await registerAccount(registered, person);

    const admin = await (await browser.newContext()).newPage();
    await signIn(admin, 'pablo.plataforma', '/operator/platform-users');
    await expect(
      admin.getByRole('heading', { level: 1, name: 'Roles de plataforma y cuentas' }),
    ).toBeVisible();
    await expect(admin.getByRole('row', { name: /pablo\.plataforma@/ })).toContainText(
      'Administración de la plataforma',
    );
    await expectNoAccessibilityViolations(admin);

    // An address nobody registered with: refused, in Spanish, next to the field.
    const grant = admin.getByRole('form', { name: 'Dar un rol' });
    await grant.getByLabel('Correo electrónico').fill(`nadie.${id}@example.org`);
    await grant.getByLabel('Rol').selectOption({ label: 'Auditoría' });
    await grant.getByLabel('Motivo').fill('Designada por la resolución 12 de la AND');
    await grant.getByRole('button', { name: 'Dar el rol' }).click();
    await expect(grant.getByText(/Ninguna cuenta del portal tiene ese correo/)).toBeVisible();
    await expectNoAccessibilityViolations(admin);

    await grant.getByLabel('Correo electrónico').fill(person.email);
    await grant.getByRole('button', { name: 'Dar el rol' }).click();
    await expect(admin.getByText('Rol otorgado.')).toBeVisible();
    const row = admin.getByRole('row', { name: new RegExp(person.email) });
    await expect(row).toContainText('Auditoría');
    await expect(row).toContainText('Activa');

    // Revoke it, with a reason.
    await admin.getByText(`Quitar Auditoría a ${name}`).click();
    const revoke = admin.getByRole('form', { name: `Quitar Auditoría a ${name}` });
    await revoke.getByRole('button', { name: 'Quitar el rol' }).click();
    await expect(revoke.getByText(/Explica el motivo/)).toBeVisible();
    await revoke.getByLabel('Motivo').fill('Dejó la comisión de auditoría');
    await revoke.getByRole('button', { name: 'Quitar el rol' }).click();
    await expect(admin.getByRole('row', { name: new RegExp(person.email) })).toHaveCount(0);

    // Disable and enable an account with no role.
    const status = admin.getByRole('form', { name: 'Desactivar o activar una cuenta' });
    await status.getByLabel('Correo electrónico').fill(person.email);
    await status.getByLabel('Motivo').fill('Cuenta comprometida, reportada por la entidad');
    await status.getByRole('button', { name: 'Desactivar la cuenta', exact: true }).click();
    await expect(admin.getByText('Cuenta desactivada.')).toBeVisible();

    await status.getByLabel('Correo electrónico').fill(person.email);
    await status.getByLabel('Motivo').fill('Falsa alarma, verificada con la entidad');
    await status.getByRole('button', { name: 'Activar la cuenta', exact: true }).click();
    await expect(admin.getByText('Cuenta activada.')).toBeVisible();
    await expectNoAccessibilityViolations(admin);

    // The console is for platform administrators only.
    const reviewer = await (await browser.newContext()).newPage();
    await signIn(reviewer, 'ana.operadora', '/operator/platform-users');
    await expect(
      reviewer.getByRole('heading', { name: 'Roles de plataforma y cuentas' }),
    ).toHaveCount(0);
    await expect(reviewer.getByRole('link', { name: 'Roles de plataforma y cuentas' })).toHaveCount(
      0,
    );
  });
});
