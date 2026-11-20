import { expect, type Browser, type Page } from '@playwright/test';
import { totp } from '../helpers';
import { waitForMail } from '../onboarding';
import { type Lang, localePath, t } from './i18n';

/** A person of the manual: synthetic, created fresh on every run. */
export interface Person {
  key: 'rosa' | 'diego' | 'tomas' | 'wanda';
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  totpSecret?: string;
  page?: Page;
}

const person = (
  language: Lang,
  suffix: string,
  key: Person['key'],
  firstName: string,
  lastName: string,
  domain: string,
): Person => ({
  key,
  username: `${key}.${language}${suffix}`,
  email: `${key}.${language}${suffix}@${domain}`,
  firstName,
  lastName,
  password: `Clave-manual-${language}-segura1`,
});

/** Provider: Rosa (administrator), Diego (data steward), Tomás (technical lead). Consumer: Wanda. */
export const peopleOf = (language: Lang, suffix = ''): Record<Person['key'], Person> => ({
  rosa: person(language, suffix, 'rosa', 'Rosa', 'Registro', 'civil-registry.example'),
  diego: person(language, suffix, 'diego', 'Diego', 'Datos', 'civil-registry.example'),
  tomas: person(language, suffix, 'tomas', 'Tomás', 'Técnico', 'civil-registry.example'),
  wanda: person(language, suffix, 'wanda', 'Wanda', 'Bienestar', 'bienestar-wakanda.example'),
});

/** A browser context of its own per person, in the run's language. */
export async function newPersonPage(browser: Browser, language: Lang): Promise<Page> {
  const context = await browser.newContext({ locale: language === 'en' ? 'en-US' : 'es' });
  return context.newPage();
}

/**
 * Self-registration (ADR-0018): Keycloak's form, the verification link from Mailpit, then the
 * password. `beforeSubmit` runs on the filled form (the manual's screenshot of it).
 */
export async function register(
  browser: Browser,
  language: Lang,
  p: Person,
  beforeSubmit?: (page: Page) => Promise<void>,
): Promise<Page> {
  const page = await newPersonPage(browser, language);
  await page.goto(localePath(language, '/'));
  await page
    .getByRole('button', { name: t(language, 'auth.signIn') })
    .first()
    .click();
  await page.waitForURL(/\/realms\/den-portal\//);
  await page.locator('a[href*="/login-actions/registration"]').click();
  await page.locator('#email').fill(p.email);
  const username = page.locator('#username');
  if (await username.isVisible()) await username.fill(p.username);
  await page.locator('#firstName').fill(p.firstName);
  await page.locator('#lastName').fill(p.lastName);
  if (beforeSubmit) await beforeSubmit(page);
  await page.locator('#kc-register-form [type="submit"]').click();

  const text = await waitForMail(p.email, /.+/);
  const link = /https?:\/\/\S+\/login-actions\/action-token\S+/.exec(text)?.[0];
  expect(link, 'verification link in the e-mail').toBeTruthy();
  await page.goto(link ?? '');
  const proceed = page.getByRole('link', { name: /Haz clic aquí|Click here|continuar|proceed/i });
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
  await page.locator('#password-new').fill(p.password);
  await page.locator('#password-confirm').fill(p.password);
  await page
    .locator('#kc-passwd-update-form [type="submit"], form [type="submit"]')
    .first()
    .click();
  await page.waitForURL((url) => !url.pathname.includes('/realms/'), { timeout: 30_000 });
  p.page = page;
  return page;
}

/** Codes already sent per person: Keycloak accepts each code once. */
const usedCodes = new Map<string, Set<string>>();

async function freshCode(p: Person, page: Page): Promise<string> {
  const used = usedCodes.get(p.username) ?? new Set<string>();
  usedCodes.set(p.username, used);
  for (;;) {
    const code = totp(Date.now(), p.totpSecret);
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  }
}

/**
 * Keycloak's CONFIGURE_TOTP, as an authenticator app would answer it: the key is read from the
 * page and kept for the person's later sign-ins. `beforeSubmit` gets the form with the code typed.
 */
export async function enrollTotp(
  page: Page,
  p: Person,
  beforeSubmit?: (page: Page) => Promise<void>,
): Promise<void> {
  const secret = page.locator('#totpSecret');
  const asked = await Promise.race([
    secret.waitFor({ state: 'attached' }).then(() => 'code' as const),
    page
      .locator('#password')
      .waitFor()
      .then(() => 'password' as const),
  ]);
  if (asked === 'password') {
    await page.locator('#password').fill(p.password);
    await page.locator('#kc-login').click();
    await secret.waitFor({ state: 'attached' });
  }
  p.totpSecret = await secret.inputValue();
  await page.locator('#totp').fill(await freshCode(p, page));
  await page.locator('#userLabel').fill('Authenticator');
  if (beforeSubmit) await beforeSubmit(page);
  await page.locator('#saveTOTPBtn').click();
  await page.waitForURL((url) => !url.pathname.includes('/realms/'));
}

/**
 * Opens a portal page as the person, signing in again if the session ended (protected pages
 * answer 404 to anonymous visitors, so the header's sign-in button is the signal).
 */
export async function ensureSignedIn(language: Lang, p: Person, path: string): Promise<Page> {
  const page = p.page;
  if (!page) throw new Error(`${p.key} has no browser page yet`);
  await page.goto(localePath(language, path));
  const signInButton = page.getByRole('button', { name: t(language, 'auth.signIn') }).first();
  if (await signInButton.isVisible().catch(() => false)) {
    await signInButton.click();
    const outcome = await Promise.race([
      page.waitForURL((url) => !url.pathname.includes('/realms/')).then(() => 'in' as const),
      page
        .locator('#username')
        .waitFor()
        .then(() => 'form' as const),
    ]);
    if (outcome === 'form') {
      await page.locator('#username').fill(p.username);
      await page.locator('#password').fill(p.password);
      await page.locator('#kc-login').click();
    }
    const otp = page.locator('#otp');
    const next = await Promise.race([
      page.waitForURL((url) => !url.pathname.includes('/realms/')).then(() => 'in' as const),
      otp.waitFor().then(() => 'otp' as const),
    ]);
    if (next === 'otp') {
      await otp.fill(await freshCode(p, page));
      await page.locator('#kc-login').click();
      await page.waitForURL((url) => !url.pathname.includes('/realms/'));
    }
    await page.goto(localePath(language, path));
  }
  return page;
}
