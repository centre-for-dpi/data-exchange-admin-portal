'use server';

import { apiVersionDetailSchema, purposeAdminListSchema } from '@den/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';
import { getViewer } from './viewer';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

const purposeBody = (formData: FormData) => ({
  name: { es: text(formData, 'name.es'), en: text(formData, 'name.en') },
  description: { es: text(formData, 'description.es'), en: text(formData, 'description.en') },
  ...(text(formData, 'legalReference') ? { legalReference: text(formData, 'legalReference') } : {}),
});

async function done(result: { ok: boolean; problem?: Parameters<typeof formStateFromProblem>[0] }) {
  if (!result.ok) {
    return await formStateFromProblem(
      result.problem,
      (await getTranslations('forms'))('unexpected'),
      {
        fullPath: true,
      },
    );
  }
  revalidatePath('/', 'layout');
  return { done: true };
}

export async function createPurposeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return done(
    await apiSend(
      'POST',
      '/admin/purposes',
      { code: text(formData, 'code'), ...purposeBody(formData) },
      purposeAdminListSchema,
    ),
  );
}

export async function updatePurposeAction(
  code: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return done(
    await apiSend('PUT', `/admin/purposes/${code}`, purposeBody(formData), purposeAdminListSchema),
  );
}

export async function setPurposeActiveAction(
  code: string,
  active: boolean,
  _prev: FormState,
): Promise<FormState> {
  return done(
    await apiSend(
      'POST',
      `/admin/purposes/${code}/${active ? 'activate' : 'deactivate'}`,
      undefined,
      purposeAdminListSchema,
    ),
  );
}

/** Data steward: the catalogue purposes a version allows (M2-10). */
export async function setVersionPurposesAction(
  apiId: string,
  versionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const entityId = (await getViewer()).activeEntity?.entity.id;
  if (!entityId) return { formError: (await getTranslations('forms'))('unexpected') };
  return done(
    await apiSend(
      'PUT',
      `/entities/${entityId}/apis/${apiId}/versions/${versionId}/purposes`,
      { allowedPurposes: formData.getAll('allowedPurposes').map(String) },
      apiVersionDetailSchema,
    ),
  );
}
