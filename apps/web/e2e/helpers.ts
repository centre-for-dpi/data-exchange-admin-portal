import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { loadCountryConfig } from '@den/config';

/** Country configuration the running app uses (no country text is hard-coded in tests). */
export const country = () => loadCountryConfig();

/** WCAG 2.1 A and AA rules (CLAUDE.md, rule 10). */
export async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary).toEqual([]);
}

/** Seed users with a critical role: the realm gives them a one-time code (M3-08). */
/** The demo password of a seed user: those with a critical role have their own (M-29). */
export function demoPassword(username: string): string {
  const shared = process.env.DEN_DEMO_USER_PASSWORD ?? 'den-demo-password';
  return MFA_USERS.has(username) ? (process.env.DEN_DEMO_CRITICAL_PASSWORD ?? shared) : shared;
}

const MFA_USERS = new Set(
  (
    JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../infra/keycloak/den-portal-realm.json'),
        'utf8',
      ),
    ) as { users: Array<{ username: string; credentials?: Array<{ type: string }> }> }
  ).users
    .filter((u) => u.credentials?.some((c) => c.type === 'otp'))
    .map((u) => u.username),
);

/** RFC 6238 TOTP like the realm's OTP policy (6 digits, 30 s, HMAC-SHA1, UTF-8 key). */
export function totp(
  at = Date.now(),
  secret = process.env.DEN_DEMO_TOTP_SECRET ?? 'den-demo-totp-secret',
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Codes this worker already sent: Keycloak accepts each code once per user. */
const usedCodes = new Map<string, Set<string>>();

/**
 * The one-time code step: after the password, the portal sees the session lacks the second
 * factor and signs in again with acr=mfa, so Keycloak shows the code form. Keycloak accepts the
 * code of this 30 s period and of the ones on either side; another worker may have used one.
 */
export async function enterOneTimeCode(page: Page, username: string): Promise<void> {
  const used = usedCodes.get(username) ?? new Set<string>();
  usedCodes.set(username, used);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.locator('#otp').waitFor();
    const code = [0, 30_000, -30_000].map((d) => totp(Date.now() + d)).find((c) => !used.has(c));
    if (!code) {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
      continue;
    }
    used.add(code);
    await page.locator('#otp').fill(code);
    await page.locator('#kc-login').click();
    const outcome = await Promise.race([
      page.waitForURL((url) => !url.pathname.includes('/realms/')).then(() => 'in' as const),
      page
        .locator('#input-error-otp')
        .filter({ hasText: /\S/ })
        .waitFor()
        .then(() => 'refused' as const),
    ]);
    if (outcome === 'in') return;
  }
  throw new Error(`Keycloak refused the one-time codes of ${username}`);
}

/**
 * Records every Content-Security-Policy violation of the page from before its first script
 * (M3-09). Call before navigating; the returned function reads what was blocked so far.
 */
export async function watchCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = list;
    document.addEventListener('securitypolicyviolation', (e) =>
      list.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations?: string[] }).cspViolations ?? []);
}

/**
 * First second factor of a new account (M3-08): the portal asked for acr=mfa and Keycloak shows
 * CONFIGURE_TOTP. Like an authenticator app, the test reads the key from the page and answers
 * with the current code.
 */
export async function enrollOneTimeCode(page: Page, password: string): Promise<void> {
  const secret = page.locator('#totpSecret');
  // A session opened by self-registration has no password level yet: Keycloak asks for it first.
  const asked = await Promise.race([
    secret.waitFor({ state: 'attached' }).then(() => 'code' as const),
    page
      .locator('#password')
      .waitFor()
      .then(() => 'password' as const),
  ]);
  if (asked === 'password') {
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
    await secret.waitFor({ state: 'attached' });
  }
  await page.locator('#totp').fill(totp(Date.now(), await secret.inputValue()));
  await page.locator('#userLabel').fill('App de la prueba');
  await page.locator('#saveTOTPBtn').click();
  await page.waitForURL((url) => !url.pathname.includes('/realms/'));
}

/** Fills Keycloak's login form (realm den-portal), and the one-time code for critical roles. */
export async function keycloakLogin(page: Page, username: string): Promise<void> {
  await page.waitForURL(/\/realms\/den-portal\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(demoPassword(username));
  await page.locator('#kc-login').click();
  if (MFA_USERS.has(username)) await enterOneTimeCode(page, username);
}
