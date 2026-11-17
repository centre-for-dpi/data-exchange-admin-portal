'use server';

import { subscriptionDetailSchema } from '@den/contracts';
import { getLocale, getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from '../i18n/navigation';
import { apiPutBytes, apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';
import { getViewer } from './viewer';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** Optional text: omitted when empty, so the API applies its default. */
const optional = (formData: FormData, name: string) => {
  const value = text(formData, name);
  return value ? { [name]: value } : {};
};

const activeEntityId = async (): Promise<string | undefined> =>
  (await getViewer()).activeEntity?.entity.id;

/** Consumer: ask for access with one of the entity's applications (SPEC.md §4.4, step 1). */
export async function requestAccessAction(
  apiVersionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const t = await getTranslations('forms');
  // The entity always comes from the session (active entity), never from the form.
  const entityId = await activeEntityId();
  if (!entityId) return { formError: t('unexpected') };
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/subscriptions`,
    {
      apiVersionId,
      applicationId: text(formData, 'applicationId'),
      purposeCode: text(formData, 'purposeCode'),
      purposeDetail: text(formData, 'purposeDetail'),
      legalBasisText: text(formData, 'legalBasisText'),
      requestedOperations: formData.getAll('requestedOperations').map(String),
      validityMonths: text(formData, 'validityMonths'),
      ...optional(formData, 'legalReference'),
      ...optional(formData, 'requestedRateLimit'),
      ...optional(formData, 'renewsSubscriptionId'),
    },
    subscriptionDetailSchema,
  );
  if (!result.ok) return await formStateFromProblem(result.problem, t('unexpected'));
  revalidatePath('/', 'layout');
  redirect({ href: `/my-apps/requests/${result.data.id}`, locale: await getLocale() });
  return {};
}

async function decide(
  subscriptionId: string,
  action: 'approve' | 'reject' | 'revoke',
  body: Record<string, unknown>,
): Promise<FormState> {
  const t = await getTranslations('forms');
  const entityId = await activeEntityId();
  if (!entityId) return { formError: t('unexpected') };
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/access-requests/${subscriptionId}/${action}`,
    body,
    subscriptionDetailSchema,
  );
  if (!result.ok) {
    // On approve/reject a 403 is separation of duties: say so in the user's language.
    if (result.status === 403 && action !== 'revoke') {
      return { formError: (await getTranslations('subscriptions.decide'))('ownRequest') };
    }
    return await formStateFromProblem(result.problem, t('unexpected'));
  }
  revalidatePath('/', 'layout');
  return {};
}

/** Provider data steward: approve, narrowing operations, validity or rate limit. */
export async function approveRequestAction(
  subscriptionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const operations = formData.getAll('approvedOperations').map(String);
  return decide(subscriptionId, 'approve', {
    // An empty selection is sent as such: the API rejects it instead of granting everything.
    approvedOperations: operations,
    validityMonths: text(formData, 'validityMonths'),
    ...optional(formData, 'rateLimitPerMinute'),
    ...optional(formData, 'comment'),
  });
}

export async function rejectRequestAction(
  subscriptionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(subscriptionId, 'reject', { comment: text(formData, 'comment') });
}

/** Provider data steward: revoke an approved or active subscription (M1-10). */
export async function revokeSubscriptionAction(
  subscriptionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(subscriptionId, 'revoke', { comment: text(formData, 'comment') });
}

export type SubscriptionStep =
  'request-info' | 'provide-info' | 'withdraw' | 'suspend' | 'reactivate';

/** Lifecycle steps (M2-06), on the provider side (access-requests) or the consumer side. */
export async function subscriptionStepAction(
  side: 'provider' | 'consumer',
  subscriptionId: string,
  step: SubscriptionStep,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const t = await getTranslations('forms');
  const entityId = await activeEntityId();
  if (!entityId) return { formError: t('unexpected') };
  const collection = side === 'provider' ? 'access-requests' : 'subscriptions';
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/${collection}/${subscriptionId}/${step}`,
    {
      ...optional(formData, 'comment'),
      ...(step === 'provide-info'
        ? { ...optional(formData, 'purposeDetail'), ...optional(formData, 'legalBasisText') }
        : {}),
    },
    subscriptionDetailSchema,
  );
  if (!result.ok) return await formStateFromProblem(result.problem, t('unexpected'));
  revalidatePath('/', 'layout');
  return {};
}

/** The requesting entity attaches the exchange agreement (PDF) to a pending request (M2-07). */
export async function uploadAgreementAction(
  subscriptionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const t = await getTranslations('subscriptions.agreement');
  const entityId = await activeEntityId();
  const file = formData.get('document');
  if (!entityId || !(file instanceof File) || file.size === 0) {
    return { fieldErrors: { document: [t('required')] } };
  }
  const name = encodeURIComponent(file.name.replace(/[/\\]/g, '_').slice(0, 200) || 'acuerdo.pdf');
  const result = await apiPutBytes(
    `/entities/${entityId}/subscriptions/${subscriptionId}/agreement?fileName=${name}`,
    await file.arrayBuffer(),
    'application/pdf',
    subscriptionDetailSchema,
  );
  if (!result.ok) {
    if (result.status === 413) return { fieldErrors: { document: [t('tooLarge')] } };
    if (result.status === 415) return { fieldErrors: { document: [t('notPdf')] } };
    return await formStateFromProblem(
      result.problem,
      (await getTranslations('forms'))('unexpected'),
    );
  }
  revalidatePath('/', 'layout');
  return { done: true };
}
