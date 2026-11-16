'use server';

import { retrySyncResultSchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import { type FormState, problemToFormState } from './forms';

/** Queues the reconcile of one target now (operator's sync console, M5-07). */
export async function retrySyncAction(target: string, _prev: FormState): Promise<FormState> {
  const result = await apiSend('POST', '/admin/sync/retry', { target }, retrySyncResultSchema);
  if (!result.ok)
    return problemToFormState(result.problem, (await getTranslations('forms'))('unexpected'));
  revalidatePath('/operator/sync');
  return { done: true };
}
