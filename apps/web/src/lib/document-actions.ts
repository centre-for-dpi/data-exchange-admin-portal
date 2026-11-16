'use server';

import { purgedDocumentSchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

/** Platform admin: delete a document's bytes by legal order (M2-07). */
export async function purgeDocumentAction(
  documentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const t = await getTranslations('documentsAdmin');
  const value = formData.get('order');
  const order = typeof value === 'string' ? value.trim() : '';
  // The deletion cannot be undone: an explicit confirmation, checked here and not only in the UI.
  if (formData.get('confirm') !== 'on') {
    return { fieldErrors: { confirm: [t('confirmRequired')] }, values: { order } };
  }
  const result = await apiSend(
    'POST',
    `/documents/${documentId}/purge`,
    { order },
    purgedDocumentSchema,
  );
  if (!result.ok)
    return {
      ...(await formStateFromProblem(
        result.problem,
        (await getTranslations('forms'))('unexpected'),
      )),
      values: { order },
    };
  revalidatePath('/', 'layout');
  return { done: true };
}
