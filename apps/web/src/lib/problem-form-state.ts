import { ZOD_ISSUE_KEY } from '@den/contracts';
import { getLocale, getTranslations } from 'next-intl/server';
import type { Problem } from './api';
import {
  type FormState,
  type ProblemFieldError,
  type ProblemTranslation,
  problemToFormState,
} from './forms';
import { zodIssueText } from './zod-issue-text';

/** The translation of the API's problems for the user's locale (M6-02, WCAG 3.1.2). */
export async function problemTranslation(): Promise<ProblemTranslation> {
  const locale = await getLocale();
  const t = await getTranslations('apiErrors');
  const tf = await getTranslations('forms');
  const params = (error: ProblemFieldError) =>
    Object.fromEntries(
      Object.entries(error.params ?? {}).filter(
        (entry): entry is [string, string | number] =>
          typeof entry[1] === 'string' || typeof entry[1] === 'number',
      ),
    );
  return {
    field: (error) => {
      if (error.key === ZOD_ISSUE_KEY) {
        return zodIssueText(error.params ?? {}, locale, tf('required')) ?? error.message;
      }
      const key = `fields.${error.key ?? ''}`;
      return error.key && t.has(key) ? t(key, params(error)) : error.message;
    },
    code: (code) => (t.has(`codes.${code}`) ? t(`codes.${code}`) : undefined),
  };
}

/** problemToFormState in the user's language: what server actions return to their forms. */
export async function formStateFromProblem(
  problem: Problem | undefined,
  fallback: string,
  options: { fullPath?: boolean } = {},
): Promise<FormState> {
  return problemToFormState(problem, fallback, {
    ...options,
    translation: await problemTranslation(),
  });
}
