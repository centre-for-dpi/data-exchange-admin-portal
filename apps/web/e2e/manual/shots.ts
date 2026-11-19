import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { Lang } from './i18n';

/** A numbered box over a screenshot, in percent of the image (the page draws it as a button). */
export interface Hotspot {
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShotEntry {
  file: string;
  width: number;
  height: number;
  hotspots: Hotspot[];
}

export interface Manifest {
  lang: Lang;
  shots: Record<string, ShotEntry>;
}

const repoRoot = resolve(import.meta.dirname, '../../../..');

/** Where a language's screenshots and their manifest live (committed with the manual). */
export const imgDir = (language: Lang): string =>
  resolve(
    repoRoot,
    language === 'en' ? 'docs/guides/img/user-manual' : 'docs/es/guides/img/user-manual',
  );

const manifestPath = (language: Lang) => resolve(imgDir(language), 'manifest.json');

/** The manifest on disk, or an empty one. */
export function readManifest(language: Lang): Manifest {
  const path = manifestPath(language);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest)
    : { lang: language, shots: {} };
}

const taken = new Map<Lang, Record<string, ShotEntry>>();

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Screenshot of one step: the region (by default the page's `main`) plus a margin, as JPEG, with
 * the boxes of the elements the step's sub-steps point at. Secrets are blurred into the image;
 * nothing else is drawn on it.
 */
export async function shot(
  page: Page,
  language: Lang,
  id: string,
  opts: { hotspots?: Locator[]; blur?: Locator[]; region?: Locator; pad?: number } = {},
): Promise<ShotEntry> {
  const pad = opts.pad ?? 16;
  const region = opts.region ?? page.locator('main').first();
  await region.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  for (const secret of opts.blur ?? []) {
    await secret.evaluate((el) => {
      (el as HTMLElement).style.filter = 'blur(8px)';
    });
  }
  // Let a transition or a late layout settle before measuring.
  await page.waitForTimeout(300);
  const scroll = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  const box = await region.boundingBox();
  if (!box) throw new Error(`shot ${id}: the region is not visible`);
  const left = Math.max(0, Math.floor(box.x + scroll.x - pad));
  const top = Math.max(0, Math.floor(box.y + scroll.y - pad));
  const clip = {
    x: left,
    y: top,
    width: Math.min(scroll.width, Math.ceil(box.x + scroll.x + box.width + pad)) - left,
    height: Math.min(scroll.height, Math.ceil(box.y + scroll.y + box.height + pad)) - top,
  };

  const hotspots: Hotspot[] = [];
  for (const [index, target] of (opts.hotspots ?? []).entries()) {
    const b = await target.boundingBox();
    if (!b) throw new Error(`shot ${id}: hotspot ${index + 1} is not visible`);
    const x = b.x + scroll.x - clip.x;
    const y = b.y + scroll.y - clip.y;
    if (x < 0 || y < 0 || x + b.width > clip.width + 1 || y + b.height > clip.height + 1) {
      throw new Error(`shot ${id}: hotspot ${index + 1} falls outside the region`);
    }
    hotspots.push({
      n: index + 1,
      x: round((x / clip.width) * 100),
      y: round((y / clip.height) * 100),
      w: round((b.width / clip.width) * 100),
      h: round((b.height / clip.height) * 100),
    });
  }

  mkdirSync(imgDir(language), { recursive: true });
  const file = `${id}.jpg`;
  await page.screenshot({
    path: resolve(imgDir(language), file),
    type: 'jpeg',
    quality: 85,
    fullPage: true,
    clip,
    animations: 'disabled',
  });
  for (const secret of opts.blur ?? []) {
    await secret.evaluate((el) => {
      (el as HTMLElement).style.filter = '';
    });
  }
  const entry = { file, width: clip.width, height: clip.height, hotspots };
  const shots = taken.get(language) ?? {};
  shots[id] = entry;
  taken.set(language, shots);
  return entry;
}

/** Writes the manifest: what is on disk plus the shots of this run, ids sorted. */
export function writeManifest(language: Lang): Manifest {
  const shots = { ...readManifest(language).shots, ...(taken.get(language) ?? {}) };
  const manifest: Manifest = {
    lang: language,
    shots: Object.fromEntries(Object.entries(shots).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(manifestPath(language), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Drops a shot from this run and from the manifest on disk (the toolkit's own test). */
export function forgetShot(language: Lang, id: string): void {
  delete taken.get(language)?.[id];
  const manifest = readManifest(language);
  delete manifest.shots[id];
  writeFileSync(manifestPath(language), `${JSON.stringify(manifest, null, 2)}\n`);
}
