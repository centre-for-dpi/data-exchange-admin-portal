import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';
import { newPerson, registerAccount, waitForMail } from './onboarding';

// M2-02: the entity_admin invites by e-mail, changes roles and revokes; a revoked member loses
// access on the next request.
test.describe('members and invitations (M2-02)', () => {
  test('elena invites a person, changes their roles and revokes them', async ({ browser }) => {
    test.setTimeout(240_000);
    const id = randomUUID().slice(0, 8);
    const invitee = newPerson('miembro', id);
    const name = `${invitee.firstName} ${invitee.lastName}`;

    const admin = await (await browser.newContext()).newPage();
    await signIn(admin, 'elena.admin', '/my-entity');
    await expect(admin.getByRole('heading', { name: 'Miembros' })).toBeVisible();
    await expectNoAccessibilityViolations(admin);

    await admin.getByLabel('Correo electrónico').fill(invitee.email);
    await admin.getByLabel('Nombre (opcional)').fill(name);
    await admin.locator('#invite-entity_viewer').check();
    await admin.getByRole('button', { name: 'Enviar invitación' }).click();
    await expect(admin.getByText('Invitación enviada.')).toBeVisible();
    await expect(
      admin.getByRole('button', { name: `Retirar la invitación a ${invitee.email}` }),
    ).toBeVisible();

    // The invitee gets the e-mail, registers with that address and accepts.
    const mail = await waitForMail(invitee.email, /Invitación/);
    expect(mail).toContain('/invitations');
    const member = await (await browser.newContext()).newPage();
    await registerAccount(member, invitee);
    await member.goto('/invitations');
    await member.getByRole('button', { name: /^Aceptar la invitación/ }).click();
    await member.waitForURL((url) => !url.pathname.includes('/invitations'));
    await member.goto('/my-entity');
    await expect(member.getByText('Consulta', { exact: true }).first()).toBeVisible();
    // A viewer sees the members but cannot manage them.
    await expect(member.getByRole('heading', { name: 'Miembros' })).toBeVisible();
    await expect(member.getByRole('button', { name: 'Enviar invitación' })).toHaveCount(0);

    // Elena makes them a publisher: effective on their next request.
    await admin.reload();
    await admin.getByText(`Gestionar a ${name}`).click();
    const roles = admin.getByRole('group', { name: `Roles de ${name}` });
    await roles.getByLabel('Consulta').uncheck();
    await roles.getByLabel('Publicación de APIs').check();
    await admin.getByRole('button', { name: 'Guardar roles' }).click();
    await expect(admin.getByRole('row', { name: new RegExp(invitee.email) })).toContainText(
      'Publicación de APIs',
    );
    await member.goto('/');
    await expect(member.getByRole('link', { name: 'Mis APIs' }).first()).toBeVisible();

    // Elena revokes them: the next request no longer shows the entity.
    const revoke = admin.getByRole('button', { name: `Revocar el acceso de ${name}` });
    if (!(await revoke.isVisible())) await admin.getByText(`Gestionar a ${name}`).click();
    await revoke.click();
    await expect(admin.getByRole('row', { name: new RegExp(invitee.email) })).toHaveCount(0);
    await member.goto('/');
    await expect(member.getByText(/Aún no tienes roles/)).toBeVisible();
    await expect(member.getByRole('link', { name: 'Mi entidad' })).toHaveCount(0);
  });
});
