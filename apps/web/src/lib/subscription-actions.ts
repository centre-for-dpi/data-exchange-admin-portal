'use server';

import { subscriptionDetailSchema } from '@rid/contracts';
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
    },
    subscriptionDetailSchema,
  );
  if (!result.ok) return problemToFormState(result.problem, t('unexpected'));
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
    return problemToFormState(result.problem, t('unexpected'));
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
