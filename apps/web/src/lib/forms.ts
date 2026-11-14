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

/** Maps an RFC 9457 problem from the API to form errors. */
export function problemToFormState(
  problem: Problem | undefined,
  fallback: string,
  options: { fullPath?: boolean } = {},
): FormState {
  const fieldErrors: Record<string, string[]> = {};
  for (const error of problem?.errors ?? []) {
    // fullPath keys nested fields as `a.b.c` (forms with grouped inputs, e.g. designees).
    const field =
      (options.fullPath ? error.path.split(/[.:]/).join('.') : error.path.split(/[.:]/)[0]) ||
      '_form';
    (fieldErrors[field] ??= []).push(error.message);
  }
  const formError =
    fieldErrors._form?.join(' ') ??
    (Object.keys(fieldErrors).length ? undefined : (problem?.detail ?? fallback));
  delete fieldErrors._form;
  return { fieldErrors, ...(formError ? { formError } : {}) };
}
