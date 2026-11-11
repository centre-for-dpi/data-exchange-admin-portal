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

/** Fills Keycloak's login form (realm rid-portal). */
export async function keycloakLogin(page: Page, username: string): Promise<void> {
  await page.waitForURL(/\/realms\/rid-portal\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(process.env.RID_DEMO_USER_PASSWORD ?? 'demo');
  await page.locator('#kc-login').click();
}
