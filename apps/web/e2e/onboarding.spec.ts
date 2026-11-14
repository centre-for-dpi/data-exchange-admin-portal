import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';
import { newPerson, registerAccount, waitForMail } from './onboarding';

// M2-01: a new official self-registers (ADR-0018), asks for their entity to join with the
// designation document, the operator approves it, and the designated data steward accepts the
// invitation that arrives by e-mail.
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

test.describe('entity onboarding (M2-01)', () => {
  test('request, review, approval and the steward joins by invitation', async ({ browser }) => {
    test.setTimeout(240_000);
    const id = randomUUID().slice(0, 8);
    const applicant = newPerson('solicitante', id);
    const steward = newPerson('datos', id);
    const legalName = `Instituto de Pruebas ${id}`;
    const shortName = `IP ${id}`;

    // The applicant registers: no roles yet, but the home page offers the onboarding.
    const page = await (await browser.newContext()).newPage();
    await registerAccount(page, applicant);
    await page.goto('/');
    await expect(page.getByText(/Aún no tienes roles/)).toBeVisible();
    await page.getByRole('link', { name: /Alta de entidades/ }).click();
    await page.waitForURL(/\/entity-requests$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Alta de entidades' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByRole('link', { name: 'Solicitar el alta de una entidad' }).click();
    await page.waitForURL(/\/entity-requests\/new$/);
    await page.getByLabel('Nombre legal').fill(legalName);
    await page.getByLabel('Nombre corto').fill(shortName);
    await page.locator('[name="slug"]').fill(`ip-${id}`);
    await page.getByLabel('Número de identificación').fill(`900${id}`);
    await page.getByLabel('Correo de contacto de la entidad').fill(`contacto.${id}@example.org`);
    await page.locator('[name="dpoName"]').fill('Dora Protección');
    await page.locator('[name="dpoEmail"]').fill(`dpo.${id}@example.org`);
    await page
      .locator('[name="designees.data_steward.fullName"]')
      .fill(`${steward.firstName} ${steward.lastName}`);
    await page.locator('[name="designees.data_steward.email"]').fill(steward.email);
    // The applicant designates themself as technical lead: no invitation, the roles are merged.
    await page
      .locator('[name="designees.technical_lead.fullName"]')
      .fill(`${applicant.firstName} ${applicant.lastName}`);
    await page.locator('[name="designees.technical_lead.email"]').fill(applicant.email);
    await expectNoAccessibilityViolations(page);
    await page.getByRole('button', { name: 'Crear la solicitud' }).click();
    await page.waitForURL(/\/entity-requests\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    await expect(page.getByRole('heading', { level: 1, name: legalName })).toBeVisible();
    await expect(page.getByText('Con el solicitante')).toBeVisible();
    await page.getByLabel('Documento de designación (PDF)').setInputFiles({
      name: 'designacion.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await page.getByRole('button', { name: 'Subir documento' }).click();
    await expect(page.getByRole('link', { name: 'designacion.pdf' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    // The document downloads through the portal with the same bytes.
    const download = await page.request.get(
      (await page.getByRole('link', { name: 'designacion.pdf' }).getAttribute('href')) ?? '',
    );
    expect(download.status()).toBe(200);
    expect(Buffer.from(await download.body()).equals(PDF)).toBe(true);

    await page.getByRole('button', { name: 'Enviar a revisión' }).click();
    await expect(page.getByText('En revisión', { exact: true })).toBeVisible();
    const requestUrl = page.url();

    // The operator finds it in the console and approves it.
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', '/operator');
    await expect(
      operator.getByRole('heading', { name: 'Altas de entidades por revisar' }),
    ).toBeVisible();
    await operator.getByRole('link', { name: legalName }).click();
    await expect(operator.getByRole('heading', { name: 'Decisión del operador' })).toBeVisible();
    await expectNoAccessibilityViolations(operator);
    await operator.getByLabel('Comentario (opcional)').fill('Designación en regla.');
    await operator.getByRole('button', { name: 'Aprobar el alta' }).click();
    await expect(
      operator.getByText('Esta solicitud no está esperando una decisión.'),
    ).toBeVisible();
    await expect(operator.getByText('Activa', { exact: true })).toBeVisible();

    // The applicant is now the entity's administrator (and technical lead).
    await page.goto(requestUrl);
    await expect(page.getByText(/La entidad fue aprobada/)).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Mis APIs/ }).first()).toBeVisible();

    // The steward receives the invitation (no secret in it), registers with that address and joins.
    const mail = await waitForMail(steward.email, new RegExp(shortName));
    expect(mail).toContain('/invitations');
    expect(mail).toContain('responsable de datos');
    const stewardPage = await (await browser.newContext()).newPage();
    await registerAccount(stewardPage, steward);
    await stewardPage.goto('/');
    await expect(stewardPage.getByText('Tienes una invitación pendiente.')).toBeVisible();
    await stewardPage.getByRole('link', { name: 'Ver invitaciones' }).click();
    await expect(stewardPage.getByRole('heading', { name: legalName })).toBeVisible();
    await expectNoAccessibilityViolations(stewardPage);
    await stewardPage
      .getByRole('button', { name: `Aceptar la invitación de ${shortName}` })
      .click();
    await stewardPage.waitForURL((url) => !url.pathname.includes('/invitations'));
    await expect(stewardPage.getByRole('link', { name: 'Solicitudes' }).first()).toBeVisible();
  });
});
