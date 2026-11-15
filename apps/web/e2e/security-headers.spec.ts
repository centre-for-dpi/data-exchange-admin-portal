import { expect, test } from '@playwright/test';
import { keycloakLogin, watchCspViolations } from './helpers';

/**
 * Security headers and cookies of the web (M3-09): a strict CSP with a per-response nonce that
 * the pages actually run under (no violation, the client components work), HSTS, no framing,
 * and session cookies the browser's scripts cannot read.
 */
test.describe('web security headers (M3-09)', () => {
  const directive = (csp: string, name: string) =>
    csp
      .split('; ')
      .find((d) => d.startsWith(`${name} `))
      ?.split(' ')
      .slice(1) ?? [];

  test('pages carry a nonce CSP, HSTS and anti-framing headers', async ({ page }) => {
    const res = await page.goto('/');
    const headers = res?.headers() ?? {};
    const csp = headers['content-security-policy'] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(directive(csp, 'script-src')).toContain("'strict-dynamic'");
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-powered-by']).toBeUndefined();

    // Every script in the HTML the server sent carries that response's nonce. (Scripts the app
    // adds later in the browser need none: strict-dynamic trusts what a nonce'd script loads.)
    const html = await page.request.get('/');
    const htmlNonce = /'nonce-([^']+)'/.exec(html.headers()['content-security-policy'] ?? '')?.[1];
    const scripts = (await html.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${htmlNonce}"`);
    // A new response, a new nonce.
    expect(htmlNonce).not.toBe(nonce);
  });

  test('the pages run under the policy: no violation, and client components work', async ({
    page,
  }) => {
    const violations = await watchCspViolations(page);
    await page.goto('/');
    // The locale switcher is a client component: it only works if the app's scripts ran.
    await page.getByRole('link', { name: 'English' }).click();
    await expect(page).toHaveURL(/\/en$/);
    await page.goto('/catalog');
    await page.waitForLoadState('networkidle');
    expect(await violations()).toEqual([]);
  });

  test('responses that are not pages load nothing and cannot be framed', async ({ request }) => {
    const session = await request.get('/api/auth/session');
    expect(session.headers()['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(session.headers()['strict-transport-security']).toBeTruthy();
    const logo = await request.get('/branding/logo');
    expect(logo.headers()['content-security-policy']).toContain("default-src 'none'");
    expect(logo.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('session cookies are HttpOnly and SameSite after signing in', async ({ page, context }) => {
    const violations = await watchCspViolations(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await keycloakLogin(page, 'carlos.dev');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Hola, Carlos Desarrollador');

    const portal = new URL(page.url()).hostname;
    const cookies = (await context.cookies()).filter((c) => c.domain.replace(/^\./, '') === portal);
    const auth = cookies.filter((c) => c.name.includes('authjs.'));
    expect(auth.map((c) => c.name)).toEqual(
      expect.arrayContaining([expect.stringContaining('authjs.session-token')]),
    );
    for (const cookie of auth) {
      expect(cookie.httpOnly, cookie.name).toBe(true);
      expect(cookie.sameSite, cookie.name).toBe('Lax');
      // Host-only: never shared with sibling hosts.
      expect(cookie.domain.startsWith('.'), cookie.name).toBe(false);
      // Over HTTPS (the pilot) Auth.js adds Secure and the __Secure-/__Host- prefixes.
      if (page.url().startsWith('https://')) expect(cookie.secure, cookie.name).toBe(true);
    }
    expect(await violations()).toEqual([]);
  });
});
