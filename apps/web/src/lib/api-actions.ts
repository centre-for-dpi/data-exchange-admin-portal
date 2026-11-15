'use server';

import { apiDetailSchema, apiVersionDetailSchema } from '@rid/contracts';
import { getLocale, getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from '../i18n/navigation';
import { apiSend } from './api';
import { type FormState, problemToFormState } from './forms';
import { getViewer } from './viewer';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

const lines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** The entity always comes from the session (active entity), never from the submitted form. */
async function activeEntityId(): Promise<string | undefined> {
  return (await getViewer()).activeEntity?.entity.id;
}

async function fail(problem: Parameters<typeof problemToFormState>[0]): Promise<FormState> {
  const t = await getTranslations('forms');
  return problemToFormState(problem, t('unexpected'));
}

async function openapiSource(formData: FormData): Promise<string> {
  const file = formData.get('openapiFile');
  if (file instanceof File && file.size > 0) return file.text();
  return text(formData, 'openapiText');
}

export async function createApiAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const entityId = await activeEntityId();
  if (!entityId) return fail(undefined);
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/apis`,
    {
      slug: text(formData, 'slug'),
      name: text(formData, 'name'),
      summary: text(formData, 'summary'),
      description: text(formData, 'description'),
      sector: text(formData, 'sector'),
      tags: text(formData, 'tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      classification: text(formData, 'classification'),
      ownerContact: text(formData, 'ownerContact'),
    },
    apiDetailSchema,
  );
  if (!result.ok) return fail(result.problem);
  revalidatePath('/', 'layout');
  redirect({ href: `/my-apis/${result.data.id}`, locale: await getLocale() });
  return {};
}

export async function createVersionAction(
  apiId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const entityId = await activeEntityId();
  if (!entityId) return fail(undefined);
  const upstreamType = text(formData, 'upstreamType');
  let exposedFields: unknown;
  try {
    exposedFields = JSON.parse(text(formData, 'exposedFields') || '[]');
  } catch {
    exposedFields = [];
  }
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/apis/${apiId}/versions`,
    {
      version: text(formData, 'version'),
      openapi: await openapiSource(formData),
      upstream:
        upstreamType === 'direct'
          ? { type: 'direct', url: text(formData, 'url'), mtls: formData.get('mtls') === 'on' }
          : {
              type: 'node',
              servicePath: text(formData, 'servicePath'),
              ...(text(formData, 'nodeId') ? { nodeId: text(formData, 'nodeId') } : {}),
            },
      exposedFields,
      allowedPurposes: formData.getAll('allowedPurposes').map(String),
      ...(text(formData, 'legalBasisText')
        ? { legalBasisText: text(formData, 'legalBasisText') }
        : {}),
      legalReferences: lines(text(formData, 'legalReferences')),
    },
    apiVersionDetailSchema,
  );
  if (!result.ok) return fail(result.problem);
  redirect({ href: `/my-apis/${apiId}/versions/${result.data.id}`, locale: await getLocale() });
  return {};
}

export async function replaceOpenapiAction(
  apiId: string,
  versionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const entityId = await activeEntityId();
  if (!entityId) return fail(undefined);
  const result = await apiSend(
    'PUT',
    `/entities/${entityId}/apis/${apiId}/versions/${versionId}/openapi`,
    { openapi: await openapiSource(formData) },
    apiVersionDetailSchema,
  );
  if (!result.ok) return fail(result.problem);
  revalidatePath('/', 'layout');
  return {};
}

export async function deprecateVersionAction(
  apiId: string,
  versionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const entityId = await activeEntityId();
  if (!entityId) return fail(undefined);
  const date = formData.get('sunsetAt');
  const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/apis/${apiId}/versions/${versionId}/deprecate`,
    // Retirement at the start of that day, UTC.
    { sunsetAt: day ? `${day}T00:00:00.000Z` : '' },
    apiVersionDetailSchema,
  );
  if (!result.ok) return fail(result.problem);
  revalidatePath('/', 'layout');
  return {};
}

export async function submitVersionAction(
  apiId: string,
  versionId: string,
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const entityId = await activeEntityId();
  if (!entityId) return fail(undefined);
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/apis/${apiId}/versions/${versionId}/submit`,
    undefined,
    apiVersionDetailSchema,
  );
  if (!result.ok) return fail(result.problem);
  revalidatePath('/', 'layout');
  return {};
}
