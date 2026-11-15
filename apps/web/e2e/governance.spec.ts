import { createHash } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { publishNewApi, requestAccess, signIn } from './flows';
import {
  approveAsSteward,
  createGatewayApplication,
  gateway,
  gatewayFetch,
  gatewayToken,
} from './gateway-flows';
import { expectNoAccessibilityViolations } from './helpers';
import { newPerson, registerAccount, waitForMail } from './onboarding';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

/** Opens the operator's actions on an entity and submits one of them. */
async function decide(
  operator: Page,
  slug: string,
  shortName: string,
  decision: 'Suspender' | 'Reactivar' | 'Dar de baja',
  reason?: string,
) {
  await operator.goto('/operator/entities');
  const row = operator.getByRole('row', { name: new RegExp(slug) });
  await row.getByText(`Gestionar ${shortName}`).click();
  const form = row.getByRole('form', { name: `${decision} ${shortName}` });
  if (reason) await form.getByLabel(/^Motivo/).fill(reason);
  await form.getByRole('button', { name: decision }).click();
  return row;
}

// M2 closed end to end: the governance of the network around one new entity. The operator
// registers it directly (M2-01), its administrator self-registers and accepts the
// invitation (M2-01/02, ADR-0018), asks for access with the exchange agreement (M2-07), the
// steward approves and the administrator is notified (M2-08), the call goes through; then the
// operator suspends the entity and the gateway denies it, reactivates it, and finally offboards
// it (M2-11). The signed export of the trail has every step (M2-09).
test.describe('M2 governance end to end', () => {
  test('register, invite, request with agreement, approve, call, suspend, offboard, audit', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const id = Date.now().toString(36);
    const slug = `gob-${id}`;
    const shortName = `Gobierno ${id}`;
    const admin = newPerson('gobierno', id);

    // 1. pablo registers the entity; its administrator is also the technical lead.
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'pablo.plataforma', '/operator/entities/new');
    await operator.getByLabel('Nombre legal').fill(`Instituto de Gobierno ${id}`);
    await operator.getByLabel('Nombre corto').fill(shortName);
    await operator.locator('[name="slug"]').fill(slug);
    await operator.getByLabel('Número de identificación').fill(`902${id}`);
    await operator
      .getByLabel('Correo de contacto de la entidad')
      .fill(`contacto.${id}@example.org`);
    await operator.locator('[name="dpoName"]').fill('Dora Protección');
    await operator.locator('[name="dpoEmail"]').fill(`dpo.${id}@example.org`);
    await operator.locator('[name="designees.data_steward.fullName"]').fill('Lina Datos');
    await operator.locator('[name="designees.data_steward.email"]').fill(`datos.${id}@example.org`);
    await operator
      .locator('[name="designees.technical_lead.fullName"]')
      .fill(`${admin.firstName} ${admin.lastName}`);
    await operator.locator('[name="designees.technical_lead.email"]').fill(admin.email);
    await operator.locator('[name="admin.fullName"]').fill(`${admin.firstName} ${admin.lastName}`);
    await operator.locator('[name="admin.email"]').fill(admin.email);
    await operator
      .getByLabel(/^Acto o decisión que fundamenta el alta/)
      .fill('Resolución 45 de 2026 del regulador.');
    await operator.getByRole('button', { name: 'Registrar entidad' }).click();
    await operator.waitForURL(/\/operator\/entities$/, { timeout: 30_000 });

    // 2. The administrator gets the e-mail, self-registers with that address and accepts.
    expect(await waitForMail(admin.email, /Invitación/)).toContain('/invitations');
    const member = await (await browser.newContext()).newPage();
    await registerAccount(member, admin);
    await member.goto('/invitations');
    await member.getByRole('button', { name: `Aceptar la invitación de ${shortName}` }).click();
    await member.waitForURL((url) => !url.pathname.includes('/invitations'));

    // 3. salud publishes an API; the new entity creates an application and asks for access,
    //    attaching the signed agreement.
    const { name: apiName, slug: apiSlug } = await publishNewApi(browser, {
      name: `Afiliación gobierno ${id}`,
      slug: `gobierno-${id}`,
    });
    const appName = `Ventanilla ${id}`;
    const { clientId, clientSecret } = await createGatewayApplication(member, appName);
    await expect(member.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });
    const subscriptionId = await requestAccess(member, apiName, appName);
    await member.getByLabel('Acuerdo de intercambio (PDF)').setInputFiles({
      name: `acuerdo-${id}.pdf`,
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await member.getByRole('button', { name: 'Adjuntar acuerdo' }).click();
    await expect(member.getByRole('link', { name: `acuerdo-${id}.pdf` })).toBeVisible();

    // 4. lucia approves; the administrator is told in the portal.
    const steward = await (await browser.newContext()).newPage();
    await approveAsSteward(steward, subscriptionId);
    await steward.context().close();
    await member.goto(`/my-apps/requests/${subscriptionId}`);
    await expect(member.getByTestId('subscription-status')).toHaveText('Activa', {
      timeout: 60_000,
    });
    await member.goto('/notifications');
    await expect(
      member.getByText(`Tu solicitud de acceso a ${apiName} fue aprobada`).first(),
    ).toBeVisible();
    await expectNoAccessibilityViolations(member);

    // 5. The call goes through the gateway.
    const url = `${gateway}/salud/${apiSlug}/v1/afiliados/1000000001`;
    const call = async () => {
      const res = await gatewayFetch(url, {
        headers: {
          authorization: `Bearer ${await gatewayToken(clientId, clientSecret)}`,
          'x-rid-purpose': 'eligibility_check',
          'x-rid-end-user': 'funcionario-7',
        },
      });
      return { status: res.status, reason: res.headers.get('x-rid-deny-reason') };
    };
    await expect.poll(call, { timeout: 60_000 }).toEqual({ status: 200, reason: null });

    // 6. The operator suspends the entity: the gateway denies its application.
    await decide(operator, slug, shortName, 'Suspender', 'Revisión del uso de los datos.');
    await expect
      .poll(call, { timeout: 90_000, intervals: [3_000] })
      .toEqual({ status: 403, reason: 'app_suspended' });

    // 7. Reactivated, it calls again.
    await decide(operator, slug, shortName, 'Reactivar');
    await expect
      .poll(call, { timeout: 90_000, intervals: [3_000] })
      .toEqual({ status: 200, reason: null });

    // 8. Offboarded: final. Its subscription is closed and its people lose access.
    const row = await decide(
      operator,
      slug,
      shortName,
      'Dar de baja',
      'La entidad fue fusionada con otra por ley.',
    );
    await expect(row.getByText('Dada de baja')).toBeVisible();
    await expect.poll(async () => (await call()).status, { timeout: 90_000 }).toBe(403);
    await member.goto(`/my-apps/requests/${subscriptionId}`);
    await expect(member.getByTestId('subscription-status')).toHaveCount(0);

    // 9. The trail of the subscription, exported and signed, tells the whole story.
    const res = await operator.request.get(
      `/files/audit/export?format=csv&targetId=${subscriptionId}`,
    );
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(res.headers()['x-rid-export-sha256']).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
    expect(res.headers()['x-rid-export-signature']).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const csv = body.toString('utf8');
    for (const action of [
      'subscription.requested',
      'subscription.agreement_attached',
      'subscription.approved',
      'subscription.revoked',
    ]) {
      expect(csv, action).toContain(`"${action}"`);
    }
  });
});
