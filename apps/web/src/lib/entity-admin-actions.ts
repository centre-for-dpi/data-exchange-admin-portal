'use server';

import { adminEntityListSchema, adminEntitySchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

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
    return await formStateFromProblem(
      result.problem,
      (await getTranslations('forms'))('unexpected'),
    );
  revalidatePath('/', 'layout');
  return { done: true };
}

/** Operator: register the entity's X-Road member, or clear it with both fields empty (M4-05). */
export async function setXroadMemberAction(
  entityId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const field = (name: string) => {
    const v = formData.get(name);
    return typeof v === 'string' ? v.trim() : '';
  };
  const memberClass = field('memberClass');
  const memberCode = field('memberCode');
  const result = await apiSend(
    'PUT',
    `/admin/entities/${entityId}/xroad-member`,
    { member: memberClass || memberCode ? { memberClass, memberCode } : null },
    adminEntitySchema,
  );
  if (!result.ok)
    return {
      ...(await formStateFromProblem(
        result.problem,
        (await getTranslations('forms'))('unexpected'),
      )),
      values: { memberClass, memberCode },
    };
  revalidatePath('/', 'layout');
  return { done: true };
}
