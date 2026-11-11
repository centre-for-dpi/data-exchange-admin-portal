import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['es', 'en'],
  // Spanish by default (CLAUDE.md, rule 7); English pages live under /en.
  defaultLocale: 'es',
  localePrefix: 'as-needed',
  // No redirect based on the browser's Accept-Language: the portal opens in Spanish and users
  // switch explicitly (the choice is remembered in a cookie).
  localeDetection: false,
});

export type AppLocale = (typeof routing.locales)[number];
