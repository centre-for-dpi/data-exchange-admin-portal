import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Languages of the user manual: the portal's UI languages. */
export type Lang = 'es' | 'en';

/** The language of this capture run (`MANUAL_LANG`), Spanish by default. */
export const lang: Lang = process.env.MANUAL_LANG === 'en' ? 'en' : 'es';

const read = (language: Lang) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../messages/${language}.json`), 'utf8'),
  ) as Record<string, unknown>;
const messages: Record<Lang, Record<string, unknown>> = { es: read('es'), en: read('en') };

/**
 * A UI text of the portal by its dotted key, as the page shows it: the capture finds buttons and
 * fields by the same texts in both languages. `{name}` placeholders are replaced from `values`.
 */
export function t(language: Lang, key: string, values: Record<string, string> = {}): string {
  let node: unknown = messages[language];
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof node !== 'string') throw new Error(`no UI text ${language}:${key}`);
  return node.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/** A portal path in the given language (`localePrefix: 'as-needed'`: Spanish has no prefix). */
export const localePath = (language: Lang, path: string): string =>
  language === 'es' ? path : `/${language}${path === '/' ? '' : path}`;
