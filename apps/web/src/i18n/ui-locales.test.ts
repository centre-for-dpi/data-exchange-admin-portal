import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_LOCALES, uiLocalesFromEnv } from './ui-locales';

describe('uiLocalesFromEnv (B-27)', () => {
  it('opens in Spanish with Spanish and English when nothing is set', () => {
    expect(uiLocalesFromEnv({})).toEqual(DEFAULT_UI_LOCALES);
  });

  it('takes the languages and the default one from the country configuration', () => {
    expect(
      uiLocalesFromEnv({
        NEXT_PUBLIC_DEN_UI_LOCALES: 'en',
        NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE: 'en',
      }),
    ).toEqual({ locales: ['en'], defaultLocale: 'en' });
  });

  it('ignores languages without a messages file and inconsistent values', () => {
    expect(
      uiLocalesFromEnv({
        NEXT_PUBLIC_DEN_UI_LOCALES: 'fr,en',
        NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE: 'en',
      }).locales,
    ).toEqual(['en']);
    expect(
      uiLocalesFromEnv({
        NEXT_PUBLIC_DEN_UI_LOCALES: 'es',
        NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE: 'en',
      }),
    ).toEqual(DEFAULT_UI_LOCALES);
  });
});
