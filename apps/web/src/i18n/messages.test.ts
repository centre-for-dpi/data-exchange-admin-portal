import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );

/**
 * Argument names of an ICU message: `{name}` and `{name, plural|select, …}`, walking into the
 * branches of plural/select. Branch keys and their texts (`approved {aprobada}`) are not
 * arguments, so translated branches do not count as different placeholders.
 */
function placeholders(text: string): string[] {
  const names: string[] = [];
  const message = (from: number, closing: boolean): number => {
    let i = from;
    while (i < text.length) {
      const c = text[i];
      if (c === '}' && closing) return i + 1;
      if (c === '{') i = argument(i + 1);
      else i += 1;
    }
    return i;
  };
  const argument = (from: number): number => {
    const head = /^\s*(\w+)\s*([,}])/.exec(text.slice(from));
    if (!head) return from;
    names.push(head[1] ?? '');
    let i = from + head[0].length;
    if (head[2] === '}') return i;
    // Skip the type (plural, select…) and read `key {message}` branches up to the closing brace.
    while (i < text.length && text[i] !== '}') {
      if (text[i] === '{') i = message(i + 1, true);
      else i += 1;
    }
    return i + 1;
  };
  message(0, false);
  return [...new Set(names)].sort();
}

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
