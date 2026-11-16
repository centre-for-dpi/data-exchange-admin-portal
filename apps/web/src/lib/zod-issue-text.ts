import { z } from 'zod';

/** A stand-in of the type zod received, to word "received <type>" (the API sends the type only). */
const SAMPLE: Record<string, unknown> = {
  undefined,
  null: null,
  string: '',
  number: 0,
  boolean: false,
  object: {},
  bigint: 0n,
};

/**
 * Words a zod issue sent by the API (code, expected type, limits...) in the user's language with
 * zod's own locale. A missing value and an empty text read as "required", like the browser's.
 */
export function zodIssueText(
  params: Record<string, unknown>,
  locale: string,
  required: string,
): string | undefined {
  const { received, ...issue } = params;
  const empty =
    (issue.code === 'invalid_type' && received === 'undefined') ||
    (issue.code === 'too_small' && issue.origin === 'string' && issue.minimum === 1);
  if (empty) return required;
  const words = (locale === 'es' ? z.locales.es() : z.locales.en()).localeError;
  const input = typeof received === 'string' && received in SAMPLE ? SAMPLE[received] : undefined;
  const text = words({ ...issue, input } as Parameters<typeof words>[0]);
  return typeof text === 'string' ? text : text?.message;
}
