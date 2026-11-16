'use server';

import { bootcampChecklistSchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

/** Confirms (or reopens) a prerequisite of the bootcamp (M4-07). */
export async function updateBootcampItemAction(
  entityId: string,
  item: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const note = formData.get('note');
  const steps = formData.get('manualStepsAvoided');
  const result = await apiSend(
    'PUT',
    `/entities/${entityId}/bootcamp/${item}`,
    {
      status: formData.get('done') === 'on' ? 'done' : 'pending',
      ...(typeof note === 'string' ? { note: note.trim() } : {}),
      // Use case only: blank clears it; anything else the API validates.
      ...(typeof steps === 'string'
        ? { manualStepsAvoided: steps.trim() === '' ? null : Number(steps) }
        : {}),
    },
    bootcampChecklistSchema,
  );
  if (!result.ok)
    return await formStateFromProblem(
      result.problem,
      (await getTranslations('forms'))('unexpected'),
    );
  revalidatePath('/', 'layout');
  return { done: true };
}
