'use server';

import { reviewDetailSchema } from '@den/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

const comment = (formData: FormData): string => {
  const value = formData.get('comment');
  return typeof value === 'string' ? value.trim() : '';
};

async function decide(
  versionId: string,
  action: 'approve' | 'request-changes',
  body: Record<string, string>,
): Promise<FormState> {
  const result = await apiSend(
    'POST',
    `/review/api-versions/${versionId}/${action}`,
    body,
    reviewDetailSchema,
  );
  if (!result.ok) {
    const t = await getTranslations('forms');
    return await formStateFromProblem(result.problem, t('unexpected'));
  }
  revalidatePath('/', 'layout');
  return {};
}

export async function approveVersionAction(
  versionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const text = comment(formData);
  return decide(versionId, 'approve', text ? { comment: text } : {});
}

export async function requestChangesAction(
  versionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(versionId, 'request-changes', { comment: comment(formData) });
}
