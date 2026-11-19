/**
 * Interface languages of the portal (B-27). They come from `country.ui` of the country
 * configuration; next.config.ts copies them into NEXT_PUBLIC_DEN_UI_LOCALES and
 * NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE at build time, because the client bundle (links, the
 * language switcher) needs them too and cannot read the configuration files. Each language needs
 * a messages file in apps/web/messages.
 */
export const UI_LOCALE_CODES = ['es', 'en'] as const;
export type UiLocaleCode = (typeof UI_LOCALE_CODES)[number];

export interface UiLocales {
  locales: UiLocaleCode[];
  defaultLocale: UiLocaleCode;
}

const isCode = (value: string): value is UiLocaleCode =>
  (UI_LOCALE_CODES as readonly string[]).includes(value);

/** Spanish by default (CLAUDE.md, rule 7), English as the other one. */
export const DEFAULT_UI_LOCALES: UiLocales = { locales: ['es', 'en'], defaultLocale: 'es' };

/** Reads the build-time variables; anything unusable falls back to the defaults. */
export function uiLocalesFromEnv(
  env: Record<string, string | undefined> = {
    // Literal accesses: Next.js inlines NEXT_PUBLIC_* only when written like this.
    NEXT_PUBLIC_DEN_UI_LOCALES: process.env.NEXT_PUBLIC_DEN_UI_LOCALES,
    NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE: process.env.NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE,
  },
): UiLocales {
  const locales = (env.NEXT_PUBLIC_DEN_UI_LOCALES ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(isCode);
  const defaultLocale = env.NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE?.trim() ?? '';
  if (locales.length === 0 || !isCode(defaultLocale) || !locales.includes(defaultLocale)) {
    return DEFAULT_UI_LOCALES;
  }
  return { locales: [...new Set(locales)], defaultLocale };
}
