'use server';

import { createdApplicationSchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import { type FormState, problemToFormState } from './forms';
import { getViewer } from './viewer';

export interface CreateApplicationState extends FormState {
  /** Present once, right after creation: the only time the secret exists outside Keycloak. */
  created?: { applicationId: string; clientId: string; clientSecret: string };
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

export async function createApplicationAction(
  _prev: CreateApplicationState,
  formData: FormData,
): Promise<CreateApplicationState> {
  const t = await getTranslations('forms');
  // The entity always comes from the session (active entity), never from the form.
  const entityId = (await getViewer()).activeEntity?.entity.id;
  if (!entityId) return { formError: t('unexpected') };
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/applications`,
    {
      name: text(formData, 'name'),
      description: text(formData, 'description'),
      environment: text(formData, 'environment'),
      technicalContact: text(formData, 'technicalContact'),
    },
    createdApplicationSchema,
  );
  if (!result.ok) return problemToFormState(result.problem, t('unexpected'));
  revalidatePath('/', 'layout');
  return {
    created: {
      applicationId: result.data.application.id,
      clientId: result.data.application.clientId,
      clientSecret: result.data.clientSecret,
    },
  };
}
