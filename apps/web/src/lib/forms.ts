import type { Problem } from './api';

/** State returned by server actions to forms (useActionState). */
export interface FormState {
  /** Field errors keyed by field name (top-level path of the API error). */
  fieldErrors?: Record<string, string[]>;
  /** Error not tied to a field. */
  formError?: string;
  /** The action succeeded (forms that stay on the page show a confirmation). */
  done?: boolean;
  /** What the user typed, to show again: React resets the form after each action. */
  values?: Record<string, string>;
}

export const initialFormState: FormState = {};

export type ProblemFieldError = NonNullable<Problem['errors']>[number];

export interface ProblemTranslation {
  /** A field error in the user's language (M6-02); its English message when there is none. */
  field?: (error: ProblemFieldError) => string;
  /** The text of a problem without field errors, by its code; undefined to use the fallback. */
  code?: (code: string) => string | undefined;
}

/**
 * Maps an RFC 9457 problem from the API to form errors. With a translation (lib/problem-form-
 * state.ts), every text is in the user's language; the API's English `detail` is never shown.
 */
export function problemToFormState(
  problem: Problem | undefined,
  fallback: string,
  options: { fullPath?: boolean; translation?: ProblemTranslation } = {},
): FormState {
  const fieldErrors: Record<string, string[]> = {};
  const word = options.translation?.field ?? ((error: ProblemFieldError) => error.message);
  for (const error of problem?.errors ?? []) {
    // fullPath keys nested fields as `a.b.c` (forms with grouped inputs, e.g. designees).
    const field =
      (options.fullPath ? error.path.split(/[.:]/).join('.') : error.path.split(/[.:]/)[0]) ||
      '_form';
    (fieldErrors[field] ??= []).push(word(error));
  }
  const byCode = options.translation
    ? problem?.code
      ? options.translation.code?.(problem.code)
      : undefined
    : problem?.detail;
  const formError =
    fieldErrors._form?.join(' ') ??
    (Object.keys(fieldErrors).length ? undefined : (byCode ?? fallback));
  delete fieldErrors._form;
  return { fieldErrors, ...(formError ? { formError } : {}) };
}
