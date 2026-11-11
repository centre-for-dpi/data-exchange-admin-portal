import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

const lookup = (obj: Record<string, unknown>, path: string): string =>
  path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], obj) as string;

describe('i18n messages', () => {
  it('defines the same keys in Spanish and English', () => {
    expect(flatten(en).sort()).toEqual(flatten(es).sort());
  });

  it('uses the same placeholders in both languages', () => {
    for (const key of flatten(es)) {
      expect(placeholders(lookup(en, key)), key).toEqual(placeholders(lookup(es, key)));
    }
  });

  it('has no empty texts', () => {
    for (const key of flatten(es)) {
      expect(lookup(es, key).trim(), key).not.toBe('');
      expect(lookup(en, key).trim(), key).not.toBe('');
    }
  });
});
