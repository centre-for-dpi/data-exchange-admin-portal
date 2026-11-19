'use server';

import { kitReleaseListSchema, kitReleaseVersionSchema } from '@den/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiGet, apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

const FIELDS = ['version', 'url', 'sizeBytes', 'sha256', 'signatureUrl', 'allowedSigners'] as const;

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** A whole number as typed ("26 006 019", "26,006,019"), or the text for the API to reject. */
const bytes = (value: string): number | string => {
  const digits = value.replace(/[\s.,_]/g, '');
  return /^\d{1,12}$/.test(digits) ? Number(digits) : value;
};

async function put(
  version: string,
  body: Record<string, unknown>,
  values?: Record<string, string>,
): Promise<FormState> {
  const t = await getTranslations('forms');
  const result = await apiSend(
    'PUT',
    `/admin/kit-releases/${encodeURIComponent(version)}`,
    body,
    kitReleaseListSchema,
  );
  if (!result.ok) {
    return { ...(await formStateFromProblem(result.problem, t('unexpected'))), values };
  }
  revalidatePath('/', 'layout');
  return { done: true };
}

/** Operator: register or correct a release of the node kit and make it current (P-03). */
export async function setKitReleaseAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = Object.fromEntries(FIELDS.map((name) => [name, text(formData, name)]));
  const version = values.version ?? '';
  if (!kitReleaseVersionSchema.safeParse(version).success) {
    const t = await getTranslations('apiErrors.fields');
    return { fieldErrors: { version: [t('semantic_version')] }, values };
  }
  return put(
    version,
    {
      url: values.url,
      sizeBytes: bytes(values.sizeBytes ?? ''),
      sha256: values.sha256,
      ...(values.signatureUrl ? { signatureUrl: values.signatureUrl } : {}),
      ...(values.allowedSigners ? { allowedSigners: values.allowedSigners } : {}),
    },
    values,
  );
}

/** Operator: make an earlier release the current version again, as it was registered. */
export async function makeKitReleaseCurrentAction(
  version: string,
  _prev: FormState,
): Promise<FormState> {
  const t = await getTranslations('forms');
  const list = await apiGet('/admin/kit-releases', kitReleaseListSchema);
  const release = list.items.find((item) => item.version === version);
  if (!release) return { formError: t('unexpected') };
  return put(version, {
    url: release.url,
    sizeBytes: release.sizeBytes,
    sha256: release.sha256,
    ...(release.signatureUrl ? { signatureUrl: release.signatureUrl } : {}),
    ...(release.allowedSigners ? { allowedSigners: release.allowedSigners } : {}),
  });
}
