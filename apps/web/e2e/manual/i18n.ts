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

/** Every dotted key of a language's messages with its text. */
function flatten(node: unknown, prefix = '', out = new Map<string, string>()) {
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}
const spanishKeys = flatten(messages.es);

/**
 * The text the portal shows in `language` for what it shows in Spanish as `es`: the journey is
 * written with the Spanish texts of the e2e tests and runs in both languages. Throws when the
 * Spanish text is unknown or ambiguous (two keys whose translations differ): pass `t()` a key then.
 */
export function ui(language: Lang, es: string): string {
  const keys = [...spanishKeys].filter(([, text]) => text === es).map(([key]) => key);
  if (!keys.length) throw new Error(`no UI text "${es}"`);
  if (language === 'es') return es;
  const translations = new Set(keys.map((key) => t(language, key)));
  if (translations.size > 1) throw new Error(`ambiguous UI text "${es}": ${keys.join(', ')}`);
  return [...translations][0] ?? es;
}

/** A portal path in the given language (`localePrefix: 'as-needed'`: Spanish has no prefix). */
export const localePath = (language: Lang, path: string): string =>
  language === 'es' ? path : `/${language}${path === '/' ? '' : path}`;
