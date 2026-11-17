import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  createApplication,
  requestAccess,
  signIn,
  submitNewApi,
  waitForValidations,
} from './flows';
import { country } from './helpers';

/**
 * WCAG 2.1 AA audit of every screen of the portal (M6-02), in Spanish and English, with the
 * role that sees the most of each one. Per screen, besides axe (WCAG 2.0/2.1 A and AA rules):
 * - 3.1.1: the page language is the locale's;
 * - 2.4.2: a title of its own (the product name alone only on the home page);
 * - 1.3.1 / 2.4.6: exactly one level-1 heading;
 * - 1.4.10: no horizontal scroll at 320 CSS pixels (tables scroll inside their own region);
 * - 2.4.1: the first Tab reaches the skip link;
 * - 2.4.7: the first interactive elements show a visible focus indicator.
 * What automation cannot judge is in docs/accessibility/WCAG-2.1-AA.md.
 */

type User =
  | 'anonymous'
  | 'pedro.publicador'
  | 'lucia.datos'
  | 'elena.admin'
  | 'carlos.dev'
  | 'ana.operadora'
  | 'pablo.plataforma'
  | 'marta.regulador'
  | 'sofia.auditora';

interface Fixture {
  apiId: string;
  versionId: string;
  appId: string;
  subscriptionId: string;
  providerId: string;
  entityRequestId: string;
  auditPath: string;
}

interface Screen {
  /** The route as in src/app/[locale]: the coverage test below matches them. */
  route: string;
  user: User;
  path: (f: Fixture) => string;
}

const SCREENS: Screen[] = [
  { route: '/', user: 'anonymous', path: () => '/' },
  { route: '/catalog', user: 'pedro.publicador', path: () => '/catalog' },
  { route: '/catalog/[apiId]', user: 'pedro.publicador', path: (f) => `/catalog/${f.apiId}` },
  {
    route: '/catalog/[apiId]/sheet/[versionId]',
    user: 'pedro.publicador',
    path: (f) => `/catalog/${f.apiId}/sheet/${f.versionId}`,
  },
  { route: '/my-apis', user: 'pedro.publicador', path: () => '/my-apis' },
  { route: '/my-apis/new', user: 'pedro.publicador', path: () => '/my-apis/new' },
  { route: '/my-apis/usage', user: 'pedro.publicador', path: () => '/my-apis/usage' },
  { route: '/my-apis/[apiId]', user: 'pedro.publicador', path: (f) => `/my-apis/${f.apiId}` },
  {
    route: '/my-apis/[apiId]/versions/new',
    user: 'pedro.publicador',
    path: (f) => `/my-apis/${f.apiId}/versions/new`,
  },
  {
    route: '/my-apis/[apiId]/versions/[versionId]',
    user: 'pedro.publicador',
    path: (f) => `/my-apis/${f.apiId}/versions/${f.versionId}`,
  },
  { route: '/notifications', user: 'pedro.publicador', path: () => '/notifications' },
  { route: '/requests', user: 'lucia.datos', path: () => '/requests' },
  {
    route: '/requests/[subscriptionId]',
    user: 'lucia.datos',
    path: (f) => `/requests/${f.subscriptionId}`,
  },
  { route: '/my-entity', user: 'elena.admin', path: () => '/my-entity' },
  { route: '/my-entity/nodes', user: 'elena.admin', path: () => '/my-entity/nodes' },
  { route: '/my-entity/bootcamp', user: 'elena.admin', path: () => '/my-entity/bootcamp' },
  { route: '/my-apps', user: 'carlos.dev', path: () => '/my-apps' },
  { route: '/my-apps/new', user: 'carlos.dev', path: () => '/my-apps/new' },
  { route: '/my-apps/[appId]', user: 'carlos.dev', path: (f) => `/my-apps/${f.appId}` },
  {
    route: '/my-apps/request',
    user: 'carlos.dev',
    path: (f) => `/my-apps/request?api=${f.apiId}&version=${f.versionId}`,
  },
  {
    route: '/my-apps/requests/[subscriptionId]',
    user: 'carlos.dev',
    path: (f) => `/my-apps/requests/${f.subscriptionId}`,
  },
  { route: '/my-apps/usage', user: 'carlos.dev', path: () => '/my-apps/usage' },
  { route: '/entity-requests', user: 'carlos.dev', path: () => '/entity-requests' },
  { route: '/entity-requests/new', user: 'carlos.dev', path: () => '/entity-requests/new' },
  {
    route: '/entity-requests/[requestId]',
    user: 'carlos.dev',
    path: (f) => `/entity-requests/${f.entityRequestId}`,
  },
  {
    route: '/entity-requests/[requestId]/edit',
    user: 'carlos.dev',
    path: (f) => `/entity-requests/${f.entityRequestId}/edit`,
  },
  { route: '/invitations', user: 'carlos.dev', path: () => '/invitations' },
  { route: '/operator', user: 'ana.operadora', path: () => '/operator' },
  {
    route: '/operator/reviews/[versionId]',
    user: 'ana.operadora',
    path: (f) => `/operator/reviews/${f.versionId}`,
  },
  { route: '/operator/entities', user: 'pablo.plataforma', path: () => '/operator/entities' },
  {
    route: '/operator/entities/new',
    user: 'pablo.plataforma',
    path: () => '/operator/entities/new',
  },
  { route: '/operator/documents', user: 'pablo.plataforma', path: () => '/operator/documents' },
  {
    route: '/operator/certificates',
    user: 'pablo.plataforma',
    path: () => '/operator/certificates',
  },
  { route: '/operator/purposes', user: 'pablo.plataforma', path: () => '/operator/purposes' },
  { route: '/operator/nodes', user: 'pablo.plataforma', path: () => '/operator/nodes' },
  { route: '/operator/bootcamp', user: 'pablo.plataforma', path: () => '/operator/bootcamp' },
  { route: '/operator/sync', user: 'pablo.plataforma', path: () => '/operator/sync' },
  { route: '/regulator', user: 'marta.regulador', path: () => '/regulator' },
  { route: '/regulator/indicators', user: 'marta.regulador', path: () => '/regulator/indicators' },
  {
    route: '/regulator/exchange-map',
    user: 'marta.regulador',
    path: () => '/regulator/exchange-map',
  },
  {
    route: '/regulator/subscriptions/[providerId]/[subscriptionId]',
    user: 'marta.regulador',
    path: (f) => `/regulator/subscriptions/${f.providerId}/${f.subscriptionId}`,
  },
  { route: '/audit', user: 'sofia.auditora', path: () => '/audit' },
  { route: '/audit/[kind]/[id]', user: 'sofia.auditora', path: (f) => f.auditPath },
];

const LOCALES = ['es', 'en'] as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Every page.tsx under src/app/[locale], as its route. */
function routesInApp(): string[] {
  const root = resolve(import.meta.dirname, '../src/app/[locale]');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'page.tsx') {
        const route = relative(root, dir).split(/[\\/]/).filter(Boolean).join('/');
        found.push(`/${route}`);
      }
    }
  };
  walk(root);
  return found.sort();
}

/** The checks of one screen; returns what failed, empty if nothing. */
async function auditScreen(page: Page, locale: string, home: boolean): Promise<string[]> {
  const failures: string[] = [];
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  for (const v of axe.violations) {
    failures.push(
      `axe ${v.id} (${v.impact ?? 'n/a'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
  }

  const facts = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    // Level-1 headings as assistive technology sees them (aria-level overrides the tag).
    h1: document.querySelectorAll('h1:not([aria-level]), [aria-level="1"]').length,
  }));
  if (facts.lang !== locale) failures.push(`3.1.1 lang="${facts.lang}"`);
  const product = country().branding.productName;
  if (!facts.title.trim() || (!home && facts.title.trim() === product)) {
    failures.push(`2.4.2 title "${facts.title}"`);
  }
  if (facts.h1 !== 1) failures.push(`1.3.1 ${facts.h1} h1`);

  // 2.4.1 and 2.4.7: from the top of the page, the skip link first, then a visible focus on
  // each of the next interactive elements.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.getAttribute('href'));
  if (first !== '#main-content') failures.push(`2.4.1 first Tab reaches ${first ?? 'nothing'}`);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1;
      const ring = style.boxShadow !== 'none';
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
      return { visible: outline || ring, name };
    });
    if (!focus) break;
    if (!focus.visible) failures.push(`2.4.7 no visible focus on ${focus.name}`);
  }

  // 1.4.12: the text spacing the criterion asks to support; no text gets clipped.
  const spacing = await page.addStyleTag({
    content: `* { line-height: 1.5 !important; letter-spacing: 0.12em !important;
      word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }`,
  });
  const clippedText = await page.evaluate(() => {
    // Text a reader sees: not visually hidden on purpose (ours and Scalar's), not decorative.
    const HIDDEN = '.sr-only, .screenreader-only, [aria-hidden="true"], .truncate';
    const clipping = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((el) => {
      const style = getComputedStyle(el);
      return (
        [style.overflowX, style.overflowY].some((o) => o === 'hidden' || o === 'clip') &&
        !el.closest(HIDDEN)
      );
    });
    const found: string[] = [];
    for (const box of clipping) {
      const edge = box.getBoundingClientRect();
      // Elements with text of their own, inside the box, that end up outside it.
      const cut = Array.from(box.querySelectorAll<HTMLElement>('*')).find((el) => {
        if (el.closest(HIDDEN)) return false;
        const ownText = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
        );
        if (!ownText) return false;
        // Reachable by scrolling a region between the text and the box (a wide table).
        for (let p = el.parentElement; p && p !== box; p = p.parentElement) {
          const o = getComputedStyle(p);
          if ([o.overflowX, o.overflowY].some((v) => v === 'auto' || v === 'scroll')) return false;
        }
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return (
          r.bottom > edge.bottom + 1 ||
          r.right > edge.right + 1 ||
          r.top < edge.top - 1 ||
          r.left < edge.left - 1
        );
      });
      if (cut) {
        found.push(
          `${cut.tagName.toLowerCase()} "${(cut.textContent ?? '').trim().slice(0, 30)}" in ${box.tagName.toLowerCase()}.${String(box.className).split(' ').slice(0, 2).join('.')}`,
        );
      }
      if (found.length >= 3) break;
    }
    return found;
  });
  for (const el of clippedText) failures.push(`1.4.12 text clipped with more spacing: ${el}`);
  await spacing.evaluate((node) => (node as Element).remove());

  // 1.4.10: reflow at 320 CSS pixels (a 1280 px window at 400 % zoom).
  const size = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 640 });
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.scrollWidth;
    if (width <= window.innerWidth + 1) return null;
    // The first element that sticks out of the page itself: not one inside a region that
    // scrolls or clips on its own (a wide table in its .table-wrap is fine).
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return true;
      }
      return false;
    };
    const culprit = Array.from(document.body.querySelectorAll<HTMLElement>('*')).find(
      (el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !clipped(el),
    );
    const name = culprit
      ? `${culprit.tagName.toLowerCase()}.${String(culprit.className).split(' ').slice(0, 3).join('.')}`
      : '?';
    return `${width}px (${name})`;
  });
  if (overflow) failures.push(`1.4.10 horizontal scroll at 320px: ${overflow}`);
  if (size) await page.setViewportSize(size);
  return failures;
}

/** The first link of the page whose path (without the locale) matches. */
async function firstHref(page: Page, pattern: RegExp): Promise<string> {
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((links) => links.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
  return hrefs.map((h) => h.replace(/^\/en(?=\/)/, '')).find((h) => pattern.test(h)) ?? '';
}

async function sessionFor(browser: Browser, user: User): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (user !== 'anonymous') await signIn(page, user);
  return page;
}

test.describe('accessibility audit of every screen (M6-02)', () => {
  test.describe.configure({ mode: 'serial' });
  let fixture: Fixture;

  test('every page of the app is in the audit', () => {
    expect(routesInApp()).toEqual(SCREENS.map((s) => s.route).sort());
  });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(400_000);
    const id = randomUUID().slice(0, 8);
    // A sensitive API of pedro (salud), approved by the operator and the regulator; an
    // application of carlos and its request, approved by lucia and waiting for the regulator:
    // the state in which every screen of the approval chain exists (M2-04).
    const name = `Accesibilidad ${id}`;
    const pedro = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(pedro, {
      name,
      slug: `accesibilidad-${id}`,
      classification: 'Datos sensibles',
    });
    await pedro.context().close();
    const apiId = UUID.exec(versionUrl.split('/my-apis/')[1] ?? '')?.[0] ?? '';
    const versionId = UUID.exec(versionUrl.split('/versions/')[1] ?? '')?.[0] ?? '';
    const ana = await sessionFor(browser, 'ana.operadora');
    await ana.goto(`/operator/reviews/${versionId}`);
    await waitForValidations(ana);
    await ana.getByRole('button', { name: 'Aprobar' }).click();
    await expect(ana.getByTestId('version-status')).toHaveText('Aprobada por el operador');
    await ana.context().close();
    const marta = await sessionFor(browser, 'marta.regulador');
    await marta.goto(`/operator/reviews/${versionId}`);
    await marta
      .getByRole('form', { name: 'Aprobar' })
      .getByRole('button', { name: 'Aprobar' })
      .click();
    await expect(marta.getByTestId('version-status')).toHaveText('Publicada');

    const carlos = await sessionFor(browser, 'carlos.dev');
    const appName = `App accesibilidad ${id}`;
    await createApplication(carlos, appName);
    // The form stays to show the secret once, with a link to the application.
    const appId = UUID.exec(await firstHref(carlos, /^\/my-apps\/[0-9a-f-]{36}$/))?.[0] ?? '';
    const subscriptionId = await requestAccess(carlos, name, appName, '6');
    const lucia = await sessionFor(browser, 'lucia.datos');
    await lucia.goto(`/requests/${subscriptionId}`);
    const approve = lucia.getByRole('form', { name: 'Aprobar' });
    await approve.getByLabel(/^Vigencia aprobada en meses/).fill('6');
    await approve.getByRole('button', { name: 'Aprobar' }).click();
    await expect(lucia.getByTestId('subscription-status')).toHaveText('Pendiente del regulador');
    await lucia.context().close();

    // An entity request of carlos, still with him (the edit page needs that state): one of an
    // earlier run when there is one, since a person has at most three open requests.
    await carlos.goto('/entity-requests');
    const open = carlos
      .getByRole('row', { name: /Con el solicitante/ })
      .locator('a[href*="/entity-requests/"]');
    let entityRequestId =
      (await open.count()) > 0
        ? (UUID.exec((await open.first().getAttribute('href')) ?? '')?.[0] ?? '')
        : '';
    if (!entityRequestId) {
      await carlos.goto('/entity-requests/new');
      await carlos.getByLabel('Nombre legal').fill(`Instituto de Accesibilidad ${id}`);
      await carlos.getByLabel('Nombre corto').fill(`IA ${id}`);
      await carlos.locator('[name="slug"]').fill(`ia-${id}`);
      await carlos.getByLabel('Número de identificación').fill(`901${id}`);
      await carlos
        .getByLabel('Correo de contacto de la entidad')
        .fill(`contacto.${id}@example.org`);
      await carlos.locator('[name="dpoName"]').fill('Dora Protección');
      await carlos.locator('[name="dpoEmail"]').fill(`dpo.${id}@example.org`);
      await carlos.locator('[name="designees.data_steward.fullName"]').fill('Rita Datos');
      await carlos.locator('[name="designees.data_steward.email"]').fill(`datos.${id}@example.org`);
      await carlos.locator('[name="designees.technical_lead.fullName"]').fill('Tomás Técnico');
      await carlos
        .locator('[name="designees.technical_lead.email"]')
        .fill(`tecnico.${id}@example.org`);
      await carlos.getByRole('button', { name: 'Crear la solicitud' }).click();
      await carlos.waitForURL(/\/entity-requests\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      entityRequestId = UUID.exec(carlos.url())?.[0] ?? '';
    }
    await carlos.context().close();

    // The provider of the subscription and an audit timeline, from the regulator's and the
    // auditor's own pages.
    await marta.goto('/regulator');
    const regulated = await firstHref(
      marta,
      new RegExp(`^/regulator/subscriptions/[0-9a-f-]{36}/${subscriptionId}$`),
    );
    const providerId = regulated.split('/')[3] ?? '';
    await marta.context().close();
    const sofia = await sessionFor(browser, 'sofia.auditora');
    await sofia.goto('/audit');
    const auditPath = await firstHref(sofia, /^\/audit\/[a-z_-]+\/[0-9a-f-]{36}$/);
    await sofia.context().close();

    fixture = {
      apiId,
      versionId,
      appId,
      subscriptionId,
      providerId,
      entityRequestId,
      auditPath,
    };
    for (const [key, value] of Object.entries(fixture)) expect(value, key).toBeTruthy();
  });

  const users = [...new Set(SCREENS.map((s) => s.user))];
  for (const user of users) {
    test(`screens of ${user}`, async ({ browser }) => {
      const screens = SCREENS.filter((s) => s.user === user);
      test.setTimeout(90_000 + screens.length * 40_000);
      const page = await sessionFor(browser, user);
      const report: string[] = [];
      for (const screen of screens) {
        for (const locale of LOCALES) {
          const path = screen.path(fixture);
          const url = locale === 'es' ? path : `/${locale}${path === '/' ? '' : path}`;
          const response = await page.goto(url);
          expect(response?.status(), url).toBe(200);
          await expect(page.locator('h1').first()).toBeVisible();
          for (const failure of await auditScreen(page, locale, screen.route === '/')) {
            report.push(`${url} — ${failure}`);
          }
        }
      }
      await page.context().close();
      // DEN_A11Y_REPORT=1 lists every finding without failing (to audit, not to gate).
      if (process.env.DEN_A11Y_REPORT) console.warn([`${user}:`, ...report].join('\n'));
      else expect(report).toEqual([]);
    });
  }
});

/** Outside the serial sweep: they need no published API and do not stop it. */
test.describe('accessibility of the session and of Keycloak (M6-02)', () => {
  test('warns before the session ends for inactivity and lets the user keep it (2.2.1)', async ({
    browser,
  }) => {
    const page = await sessionFor(browser, 'carlos.dev');
    await page.clock.install();
    await page.goto('/my-apps');
    // The countdown starts once the page is hydrated: only then move the clock.
    await page.getByTestId('session-timeout').waitFor({ state: 'attached' });
    // Two minutes before the realm's 30 idle minutes.
    await page.clock.fastForward('28:30');
    const dialog = page.getByRole('alertdialog', { name: 'Tu sesión está por terminar' });
    await expect(dialog).toBeVisible();
    const stay = dialog.getByRole('button', { name: 'Seguir conectado' });
    await expect(stay).toBeFocused();
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    await stay.click();
    await expect(dialog).toBeHidden();
    // The session is still there.
    await page.goto('/my-apps');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.context().close();
  });

  // Keycloak's own pages are part of the flow (sign-in, registration): its default theme, not
  // ours, so only axe, and what it finds goes to docs/accessibility/WCAG-2.1-AA.md.
  test("Keycloak's sign-in and registration pages", async ({ page }) => {
    const report: string[] = [];
    const audit = async (name: string) => {
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      for (const v of axe.violations) {
        report.push(`${name} — axe ${v.id} (${v.impact ?? 'n/a'}): ${v.nodes.length} nodes`);
      }
    };
    await page.goto('/');
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await page.waitForURL(/\/realms\/den-portal\//);
    await audit('sign-in');
    await page.locator('a[href*="/login-actions/registration"]').click();
    await page.locator('#kc-register-form').waitFor();
    await audit('registration');
    if (process.env.DEN_A11Y_REPORT) console.warn(['keycloak:', ...report].join('\n'));
    else expect(report).toEqual([]);
  });
});
