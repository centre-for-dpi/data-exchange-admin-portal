import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { lang, localePath, t } from './i18n';
import { forgetShot, imgDir, readManifest, shot, writeManifest } from './shots';

test('shot writes a cropped JPEG and hotspot boxes in percent', async ({ page }) => {
  await page.goto(localePath(lang, '/'));
  const signIn = page.getByRole('button', { name: t(lang, 'auth.signIn') }).first();
  await expect(signIn).toBeVisible();
  const file = resolve(imgDir(lang), 'zz-toolkit.jpg');
  try {
    await shot(page, lang, 'zz-toolkit', {
      region: page.locator('body'),
      hotspots: [signIn],
      pad: 0,
    });
    writeManifest(lang);

    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeLessThan(400_000);
    const entry = readManifest(lang).shots['zz-toolkit'];
    expect(entry?.file).toBe('zz-toolkit.jpg');
    expect(entry?.hotspots).toHaveLength(1);
    const [spot] = entry?.hotspots ?? [];
    expect(spot?.n).toBe(1);
    expect(spot?.x).toBeGreaterThanOrEqual(0);
    expect(spot?.y).toBeGreaterThanOrEqual(0);
    expect((spot?.x ?? 0) + (spot?.w ?? 0)).toBeLessThanOrEqual(100);
    expect((spot?.y ?? 0) + (spot?.h ?? 0)).toBeLessThanOrEqual(100);
    expect(spot?.w).toBeGreaterThan(0);
  } finally {
    rmSync(file, { force: true });
    forgetShot(lang, 'zz-toolkit');
    // An empty manifest left only by this test is not kept.
    if (Object.keys(readManifest(lang).shots).length === 0) {
      rmSync(resolve(imgDir(lang), 'manifest.json'), { force: true });
    }
  }
});
