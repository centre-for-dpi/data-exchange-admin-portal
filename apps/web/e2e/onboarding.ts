import { expect, type Page } from '@playwright/test';
import { mailsTo, mailText } from './citizen';

export interface NewPerson {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

export const newPerson = (label: string, id: string): NewPerson => ({
  username: `${label}-${id}`,
  email: `${label}.${id}@example.org`,
  firstName: label.charAt(0).toUpperCase() + label.slice(1),
  lastName: `Prueba ${id}`,
  password: `Clave-${id}-segura`,
});

/** Waits for a message to `address` whose subject matches, and returns its text. */
export async function waitForMail(address: string, subject: RegExp): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await mailsTo(address)).find((m) => subject.test(m.Subject))?.ID;
        return id;
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBeTruthy();
  return mailText(id ?? '');
}

/**
 * Self-registration in the portal realm (ADR-0018): Keycloak's registration form, the
 * verification link it e-mails (Mailpit), then the password, which Keycloak only lets the person
 * choose once the address is verified. That finishes the login back in the portal.
 */
export async function registerAccount(page: Page, person: NewPerson): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
  await page.waitForURL(/\/realms\/rid-portal\//);
  await page.locator('a[href*="/login-actions/registration"]').click();
  await page.locator('#email').fill(person.email);
  const username = page.locator('#username');
  if (await username.isVisible()) await username.fill(person.username);
  await page.locator('#firstName').fill(person.firstName);
  await page.locator('#lastName').fill(person.lastName);
  // Keycloak 26.8 with verifyEmail asks for the password only after the e-mail is verified.
  await page.locator('#kc-register-form [type="submit"]').click();

  const text = await waitForMail(person.email, /.+/);
  const link = /https?:\/\/\S+\/login-actions\/action-token\S+/.exec(text)?.[0];
  expect(link, 'verification link in the e-mail').toBeTruthy();
  await page.goto(link ?? '');
  // Keycloak may ask to confirm before using the link in a new step of the flow.
  const proceed = page.getByRole('link', { name: /Haz clic aquí|Click here|continuar|proceed/i });
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
  await page.locator('#password-new').fill(person.password);
  await page.locator('#password-confirm').fill(person.password);
  await page
    .locator('#kc-passwd-update-form [type="submit"], form [type="submit"]')
    .first()
    .click();
  await page.waitForURL((url) => !url.pathname.includes('/realms/'), { timeout: 30_000 });
}
