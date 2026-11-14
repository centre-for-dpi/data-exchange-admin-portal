'use server';

import { adminEntityListSchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import { type FormState, problemToFormState } from './forms';

export type EntityDecision = 'suspend' | 'reactivate' | 'offboard';

/** Operator: suspend, reactivate or offboard an entity (M2-11). */
export async function decideEntityStatusAction(
  entityId: string,
  decision: EntityDecision,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const value = formData.get('comment');
  const comment = typeof value === 'string' ? value.trim() : '';
  const body =
    decision === 'suspend'
      ? { comment, alsoAsProvider: formData.get('alsoAsProvider') === 'on' }
      : decision === 'offboard'
        ? { comment }
        : comment
          ? { comment }
          : {};
  const result = await apiSend(
    'POST',
    `/admin/entities/${entityId}/${decision}`,
    body,
    adminEntityListSchema,
  );
  if (!result.ok)
    return problemToFormState(result.problem, (await getTranslations('forms'))('unexpected'));
  revalidatePath('/', 'layout');
  return { done: true };
}
