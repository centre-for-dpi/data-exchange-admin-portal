import { defineRouting } from 'next-intl/routing';
import { uiLocalesFromEnv } from './ui-locales';

const ui = uiLocalesFromEnv();

export const routing = defineRouting({
  // From the country configuration (country.ui), see ui-locales.ts.
  locales: ui.locales,
  // Spanish unless the country says otherwise (CLAUDE.md, rule 7); other languages live under /<code>.
  defaultLocale: ui.defaultLocale,
  localePrefix: 'as-needed',
  // No redirect based on the browser's Accept-Language: the portal opens in its default language
  // and users switch explicitly (the choice is remembered in a cookie).
  localeDetection: false,
});

export type AppLocale = (typeof ui.locales)[number];
