'use server';

import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  notificationPreferencesSchema,
} from '@den/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

export async function markAllReadAction(_prev: FormState): Promise<FormState> {
  const result = await apiSend(
    'POST',
    '/me/notifications/read-all',
    undefined,
    z.object({ updated: z.number() }),
  );
  if (!result.ok)
    return await formStateFromProblem(
      result.problem,
      (await getTranslations('forms'))('unexpected'),
    );
  revalidatePath('/', 'layout');
  return { done: true };
}

/** Saves the e-mail choice of every editable kind; unchecked boxes mean "no e-mail". */
export async function savePreferencesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const chosen = new Set(formData.getAll('email').map(String));
  const items = (Object.keys(NOTIFICATION_KINDS) as NotificationKind[])
    .filter((kind) => NOTIFICATION_KINDS[kind].email && !NOTIFICATION_KINDS[kind].security)
    .map((kind) => ({ kind, email: chosen.has(kind) }));
  const result = await apiSend(
    'PUT',
    '/me/notification-preferences',
    { items },
    notificationPreferencesSchema,
  );
  if (!result.ok)
    return await formStateFromProblem(
      result.problem,
      (await getTranslations('forms'))('unexpected'),
    );
  revalidatePath('/', 'layout');
  return { done: true };
}
