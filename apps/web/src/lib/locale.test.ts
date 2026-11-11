import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, isSupportedLocale } from './locale';

describe('locale', () => {
  it('defaults to Spanish', () => {
    expect(DEFAULT_LOCALE).toBe('es');
  });

  it('recognises supported locales only', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
  });
});
