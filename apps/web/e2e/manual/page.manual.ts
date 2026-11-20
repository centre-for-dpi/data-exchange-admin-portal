import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { expectNoAccessibilityViolations } from '../helpers';

// The user manual's page itself (scripts/user-manual-html.mjs + user-manual-page.mjs), built from
// a small fixture: role filter, progress, hotspots, lightbox, tabs, search, copy link, print,
// phone width, blocked storage and accessibility. No stack needed.

const repoRoot = resolve(import.meta.dirname, '../../../..');
const FENCE = '```';
const FIXTURE = `# Manual de prueba

Lede del manual.

| Qué | Ejemplo |
| :-- | :-- |
| Portal | \`https://portal.example.org\` |

## 1. Alta

<!-- roles: provider -->

1. Llena el formulario.
2. Pulsa **Crear**.

![Formulario de alta](img/user-manual/a.jpg "El formulario de alta")

## 2. Revisión

<!-- roles: operator -->

1. Abre la solicitud.

![Consola del operador](img/user-manual/b.jpg "La consola del operador")

${FENCE}bash tab="Linux o macOS"
ls -la
curl -sS --cacert red-ca.pem --cert app.pem --key app.key -H "Authorization: Bearer $TOKEN" -H "X-DEN-Purpose: eligibility_check" https://gateway.example.org/civil-registry/certificados-afiliacion/v1/afiliados/1000000001
${FENCE}

${FENCE}powershell tab="Windows: PowerShell"
dir
${FENCE}

## 3. Consulta

<!-- roles: consumer -->

> **Consejo:** usa la palabra zanahoria.

Atención al titular de los datos.

## Si algo falla

| Síntoma | Qué hacer |
| :-- | :-- |
| Token vencido | Pide otro |
`;
const MANIFEST = {
  lang: 'es',
  shots: {
    a: {
      file: 'a.jpg',
      width: 800,
      height: 600,
      hotspots: [
        { n: 1, x: 10, y: 10, w: 30, h: 10 },
        { n: 2, x: 10, y: 60, w: 20, h: 10 },
      ],
    },
    b: { file: 'b.jpg', width: 800, height: 400, hotspots: [{ n: 1, x: 50, y: 40, w: 30, h: 20 }] },
  },
};
// A 1×1 grey PNG: the browser sniffs the type, the page sizes it from the manifest.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGO4BwAA0wDPvBTi4AAAAABJRU5ErkJggg==',
  'base64',
);

let pageUrl = '';

test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'den-manual-'));
  mkdirSync(join(dir, 'img/user-manual'), { recursive: true });
  writeFileSync(join(dir, 'img/user-manual/a.jpg'), PIXEL);
  writeFileSync(join(dir, 'img/user-manual/b.jpg'), PIXEL);
  writeFileSync(join(dir, 'manual.md'), FIXTURE);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
  const out = join(dir, 'manual.html');
  execFileSync('node', [
    resolve(repoRoot, 'scripts/user-manual-html.mjs'),
    '--md',
    join(dir, 'manual.md'),
    '--manifest',
    join(dir, 'manifest.json'),
    '--lang',
    'es',
    '--out',
    out,
  ]);
  // Like the docs site (scripts/docs-site.sh): the guides are fragments wrapped with their language.
  writeFileSync(out, `<!doctype html>\n<html lang="es">\n${readFileSync(out, 'utf8')}\n</html>\n`);
  pageUrl = pathToFileURL(out).href;
});

const open = async (page: Page) => {
  await page.goto(pageUrl);
  await expect(page.locator('[id="1-alta"]')).toBeVisible();
};

test('role filter dims other roles and survives a reload', async ({ page }) => {
  await open(page);
  await page.getByRole('radio', { name: 'Entidad proveedora' }).check();
  await expect(page.locator('[id="2-revision"]')).toHaveAttribute('data-dimmed', '');
  await expect(page.locator('[id="3-consulta"]')).toHaveAttribute('data-dimmed', '');
  await expect(page.locator('[id="1-alta"]')).not.toHaveAttribute('data-dimmed');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Entidad proveedora' })).toBeChecked();
  await expect(page.locator('[id="2-revision"]')).toHaveAttribute('data-dimmed', '');
  await page.getByRole('radio', { name: 'Todos' }).check();
  await expect(page.locator('[id="2-revision"]')).not.toHaveAttribute('data-dimmed');
});

test('each Done checkbox names its step', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('checkbox', { name: 'Hecho: 2. Revisión' })).toBeVisible();
});

test('progress counts done steps', async ({ page }) => {
  await open(page);
  const progress = page.locator('[data-progress]');
  await expect(progress).toHaveText('0 de 3 pasos hechos');
  await page.locator('[data-done="1-alta"]').check();
  await expect(progress).toHaveText('1 de 3 pasos hechos');
  await page.reload();
  await expect(page.locator('[data-done="1-alta"]')).toBeChecked();
  await expect(progress).toHaveText('1 de 3 pasos hechos');
  await page.getByRole('button', { name: 'Reiniciar el avance' }).click();
  await expect(progress).toHaveText('0 de 3 pasos hechos');
  await expect(page.locator('[data-done="1-alta"]')).not.toBeChecked();
});

test('hotspot moves focus to its sub-step', async ({ page }) => {
  await open(page);
  await page.locator('#shot-a .hotspot').nth(1).click();
  await expect(page.locator('[id="1-alta-1-2"]')).toBeFocused();
  await expect(page.locator('[id="1-alta-1-2"]')).toHaveClass(/flash/);
});

test('keyboard-only use', async ({ page }) => {
  await open(page);
  const opener = page.locator('#shot-a .shot-open');
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('dialog.shot-dialog');
  await expect(dialog).toHaveAttribute('open', '');
  await expect(dialog.locator('img')).toHaveAttribute('alt', 'Formulario de alta');
  await expect(dialog.locator('.hotspot')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toHaveAttribute('open');
  await expect(opener).toBeFocused();

  // A hotspot answers Enter too.
  await page.locator('#shot-b .hotspot').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[id="2-revision-1-1"]')).toBeFocused();

  // Tabs: arrow keys move between them, and the panel follows.
  const linux = page.getByRole('tab', { name: 'Linux o macOS' });
  const windows = page.getByRole('tab', { name: 'Windows: PowerShell' });
  await linux.focus();
  await page.keyboard.press('ArrowRight');
  await expect(windows).toBeFocused();
  await expect(windows).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('dir');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Windows: PowerShell' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('search ignores accents', async ({ page }) => {
  await open(page);
  await page.getByLabel('Buscar en el manual').fill('atencion al titular');
  await expect(page.locator('[id="3-consulta"]')).toBeVisible();
  await expect(page.locator('[id="1-alta"]')).toBeHidden();
});

test('search filters sections and announces the count', async ({ page }) => {
  await open(page);
  await page.getByLabel('Buscar en el manual').fill('zanahoria');
  await expect(page.locator('[id="3-consulta"]')).toBeVisible();
  await expect(page.locator('[id="1-alta"]')).toBeHidden();
  await expect(page.locator('.search-status')).toHaveText('1 pasos coinciden');
  await page.getByLabel('Buscar en el manual').fill('nada-de-esto');
  await expect(page.locator('.search-status')).toHaveText(
    'No hay pasos que coincidan con la búsqueda.',
  );
  await page.getByLabel('Buscar en el manual').fill('');
  await expect(page.locator('[id="1-alta"]')).toBeVisible();
});

test('copy link announces it', async ({ page }) => {
  await open(page);
  await page.locator('[data-copy-link="#2-revision"]').click();
  await expect(page.locator('.search-status')).toHaveText('Enlace copiado');
});

test('works when storage throws', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('storage blocked');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.getByRole('radio', { name: 'Operador' }).check();
  await expect(page.locator('[id="1-alta"]')).toHaveAttribute('data-dimmed', '');
  await page.locator('[data-done="2-revision"]').check();
  await expect(page.locator('[data-progress]')).toHaveText('1 de 3 pasos hechos');
  expect(errors).toEqual([]);
});

test('phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const image = await page.locator('#shot-a img').boundingBox();
  const spot = await page.locator('#shot-a .hotspot').nth(1).boundingBox();
  expect(image && spot).toBeTruthy();
  if (image && spot) {
    expect(spot.x).toBeGreaterThanOrEqual(image.x - 1);
    expect(spot.y).toBeGreaterThanOrEqual(image.y - 1);
    expect(spot.x + spot.width).toBeLessThanOrEqual(image.x + image.width + 1);
    expect(spot.y + spot.height).toBeLessThanOrEqual(image.y + image.height + 1);
  }
});

test('print hides controls and dims nothing', async ({ page }) => {
  await open(page);
  await page.getByRole('radio', { name: 'Operador' }).check();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.manual-tools')).toBeHidden();
  await expect(page.locator('.copy-link').first()).toBeHidden();
  expect(await page.locator('[id="1-alta"]').evaluate((el) => getComputedStyle(el).opacity)).toBe(
    '1',
  );
});

test('no accessibility violations, light and dark', async ({ page }) => {
  await open(page);
  await expectNoAccessibilityViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoAccessibilityViolations(page);
});
