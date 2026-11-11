import type { Problem } from './api';

/** State returned by server actions to forms (useActionState). */
export interface FormState {
  /** Field errors keyed by field name (top-level path of the API error). */
  fieldErrors?: Record<string, string[]>;
  /** Error not tied to a field. */
  formError?: string;
}

export const initialFormState: FormState = {};

/** Maps an RFC 9457 problem from the API to form errors. */
export function problemToFormState(problem: Problem | undefined, fallback: string): FormState {
  const fieldErrors: Record<string, string[]> = {};
  for (const error of problem?.errors ?? []) {
    const field = error.path.split(/[.:]/)[0] || '_form';
    (fieldErrors[field] ??= []).push(error.message);
  }
  const formError =
    fieldErrors._form?.join(' ') ??
    (Object.keys(fieldErrors).length ? undefined : (problem?.detail ?? fallback));
  delete fieldErrors._form;
  return { fieldErrors, ...(formError ? { formError } : {}) };
}
