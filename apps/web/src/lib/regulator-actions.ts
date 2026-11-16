'use server';

import { reviewDetailSchema, subscriptionDetailSchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

export type RegulatorTarget = 'api-versions' | 'subscriptions';
export type RegulatorDecision = 'approve' | 'request-changes' | 'reject';

/** The regulator's decision on a sensitive publication or access request (M2-04). */
export async function regulatorDecideAction(
  target: RegulatorTarget,
  id: string,
  decision: RegulatorDecision,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const value = formData.get('comment');
  const comment = typeof value === 'string' ? value.trim() : '';
  const result = await apiSend(
    'POST',
    `/regulator/${target}/${id}/${decision}`,
    comment || decision !== 'approve' ? { comment } : {},
    target === 'api-versions' ? reviewDetailSchema : subscriptionDetailSchema,
  );
  if (!result.ok) {
    const t = await getTranslations('forms');
    return await formStateFromProblem(result.problem, t('unexpected'));
  }
  revalidatePath('/', 'layout');
  return { done: true };
}
