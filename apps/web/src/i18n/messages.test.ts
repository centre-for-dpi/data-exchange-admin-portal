import { ErrorCode, FieldErrorKey, ValidationMessage } from '@den/contracts';
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
      // ICU quoting: '' is an apostrophe; an apostrophe before { or } starts literal text up to
      // the next apostrophe ('{entidad}' is a placeholder shown as is, not an argument).
      if (c === "'" && text[i + 1] === "'") i += 2;
      else if (c === "'" && (text[i + 1] === '{' || text[i + 1] === '}')) {
        const end = text.indexOf("'", i + 1);
        i = end === -1 ? text.length : end + 1;
      } else if (c === '{') i = argument(i + 1);
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

  it('words every field error key and problem code of the API (M6-02)', () => {
    const keys = flatten(es);
    const fields = [...Object.values(FieldErrorKey), ...Object.keys(ValidationMessage)];
    expect(fields.filter((k) => !keys.includes(`apiErrors.fields.${k}`))).toEqual([]);
    expect(Object.values(ErrorCode).filter((c) => !keys.includes(`apiErrors.codes.${c}`))).toEqual(
      [],
    );
  });
});
