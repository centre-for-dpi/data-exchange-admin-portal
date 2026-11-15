import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { loadCountryConfig } from '@rid/config';

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
const MFA_USERS = new Set(
  (
    JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../infra/keycloak/rid-portal-realm.json'),
        'utf8',
      ),
    ) as { users: Array<{ username: string; credentials?: Array<{ type: string }> }> }
  ).users
    .filter((u) => u.credentials?.some((c) => c.type === 'otp'))
    .map((u) => u.username),
);

/** RFC 6238 TOTP like the realm's OTP policy (6 digits, 30 s, HMAC-SHA1, UTF-8 key). */
export function totp(at = Date.now()): string {
  const secret = process.env.RID_DEMO_TOTP_SECRET ?? 'rid-demo-totp-secret';
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

/** Fills Keycloak's login form (realm rid-portal), and the one-time code for critical roles. */
export async function keycloakLogin(page: Page, username: string): Promise<void> {
  await page.waitForURL(/\/realms\/rid-portal\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(process.env.RID_DEMO_USER_PASSWORD ?? 'demo');
  await page.locator('#kc-login').click();
  if (MFA_USERS.has(username)) await enterOneTimeCode(page, username);
}
