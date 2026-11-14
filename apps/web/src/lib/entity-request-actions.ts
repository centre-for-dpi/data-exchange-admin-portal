'use server';

import { DESIGNEE_ROLES, entityRequestSchema, membershipSummarySchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { redirect } from '../i18n/navigation';
import { apiPutBytes, apiSend } from './api';
import { type FormState, problemToFormState } from './forms';
import { ACTIVE_ENTITY_COOKIE } from './viewer';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** Form fields -> the API body (entityRequestInputSchema). The API validates everything. */
function requestBody(formData: FormData) {
  const website = text(formData, 'website');
  return {
    legalName: text(formData, 'legalName'),
    shortName: text(formData, 'shortName'),
    slug: text(formData, 'slug'),
    taxIdType: text(formData, 'taxIdType'),
    taxId: text(formData, 'taxId'),
    kind: text(formData, 'kind'),
    sector: text(formData, 'sector'),
    contactEmail: text(formData, 'contactEmail'),
    website: website || null,
    dpoName: text(formData, 'dpoName'),
    dpoEmail: text(formData, 'dpoEmail'),
    designees: Object.fromEntries(
      DESIGNEE_ROLES.map((role) => [
        role,
        {
          fullName: text(formData, `designees.${role}.fullName`),
          email: text(formData, `designees.${role}.email`),
        },
      ]),
    ),
  };
}

async function failed(problem: Parameters<typeof problemToFormState>[0]): Promise<FormState> {
  const t = await getTranslations('forms');
  return problemToFormState(problem, t('unexpected'), { fullPath: true });
}

export async function createEntityRequestAction(
  locale: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await apiSend(
    'POST',
    '/entity-requests',
    requestBody(formData),
    entityRequestSchema,
  );
  if (!result.ok) return failed(result.problem);
  revalidatePath('/', 'layout');
  redirect({ href: `/entity-requests/${result.data.id}`, locale });
  return {};
}

export async function updateEntityRequestAction(
  requestId: string,
  locale: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await apiSend(
    'PUT',
    `/entity-requests/${requestId}`,
    requestBody(formData),
    entityRequestSchema,
  );
  if (!result.ok) return failed(result.problem);
  revalidatePath('/', 'layout');
  redirect({ href: `/entity-requests/${requestId}`, locale });
  return {};
}

export async function uploadDesignationAction(
  requestId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const file = formData.get('document');
  if (!(file instanceof File) || file.size === 0) {
    const t = await getTranslations('entityRequests.document');
    return { fieldErrors: { document: [t('required')] } };
  }
  const name = encodeURIComponent(file.name.replace(/[/\\]/g, '_').slice(0, 200) || 'document.pdf');
  const result = await apiPutBytes(
    `/entity-requests/${requestId}/designation-document?fileName=${name}`,
    await file.arrayBuffer(),
    'application/pdf',
    entityRequestSchema,
  );
  if (!result.ok) {
    const t = await getTranslations('entityRequests.document');
    if (result.status === 413) return { fieldErrors: { document: [t('tooLarge')] } };
    if (result.status === 415) return { fieldErrors: { document: [t('notPdf')] } };
    return failed(result.problem);
  }
  revalidatePath('/', 'layout');
  return {};
}

export async function submitEntityRequestAction(
  requestId: string,
  _prev: FormState,
): Promise<FormState> {
  const result = await apiSend(
    'POST',
    `/entity-requests/${requestId}/submit`,
    undefined,
    entityRequestSchema,
  );
  if (!result.ok) return failed(result.problem);
  revalidatePath('/', 'layout');
  return {};
}

export async function decideEntityRequestAction(
  requestId: string,
  decision: 'approve' | 'request-changes' | 'reject',
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const comment = text(formData, 'comment');
  const result = await apiSend(
    'POST',
    `/review/entities/${requestId}/${decision}`,
    comment || decision !== 'approve' ? { comment } : {},
    entityRequestSchema,
  );
  if (!result.ok) return failed(result.problem);
  revalidatePath('/', 'layout');
  return {};
}

/** Accepts the invitation and switches the portal to the entity just joined. */
export async function acceptInvitationAction(
  invitationId: string,
  locale: string,
  _prev: FormState,
): Promise<FormState> {
  const result = await apiSend(
    'POST',
    `/me/invitations/${invitationId}/accept`,
    undefined,
    membershipSummarySchema,
  );
  if (!result.ok) return failed(result.problem);
  (await cookies()).set(ACTIVE_ENTITY_COOKIE, result.data.entity.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.AUTH_URL ?? '').startsWith('https://'),
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  revalidatePath('/', 'layout');
  redirect({ href: '/', locale });
  return {};
}

export async function declineInvitationAction(
  invitationId: string,
  _prev: FormState,
): Promise<FormState> {
  const result = await apiSend(
    'POST',
    `/me/invitations/${invitationId}/decline`,
    undefined,
    z.undefined(),
  );
  if (!result.ok) return failed(result.problem);
  revalidatePath('/', 'layout');
  return {};
}
