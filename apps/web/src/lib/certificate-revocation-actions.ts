'use server';

import { certificateRevocationResultSchema } from '@den/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from '../i18n/navigation';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

const FILTERS = ['entityId', 'issuedFrom', 'issuedTo', 'issuer'] as const;

/**
 * Platform admin: revoke every live client certificate matching the previewed filters (M6-07).
 * The filters and the count come from the preview the operator saw; the API refuses (409) if the
 * set changed since.
 */
export async function revokeCertificatesAction(
  locale: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const t = await getTranslations('certificateRevocations');
  const text = (key: string) => {
    const value = formData.get(key);
    return typeof value === 'string' ? value.trim() : '';
  };
  const reason = text('reason');
  // It cannot be undone: an explicit confirmation, checked here and not only in the UI.
  if (formData.get('confirm') !== 'on') {
    return { fieldErrors: { confirm: [t('confirmRequired')] }, values: { reason } };
  }
  const body: Record<string, unknown> = { reason, expectedCount: Number(text('expectedCount')) };
  for (const key of FILTERS) if (text(key)) body[key] = text(key);
  const result = await apiSend(
    'POST',
    '/admin/certificate-revocations',
    body,
    certificateRevocationResultSchema,
  );
  if (!result.ok)
    return {
      ...(await formStateFromProblem(
        result.problem,
        (await getTranslations('forms'))('unexpected'),
      )),
      values: { reason },
    };
  revalidatePath('/', 'layout');
  // The preview is empty now: the page says what was done (?revoked=).
  redirect({ href: `/operator/certificates?revoked=${result.data.revoked}`, locale });
  return {};
}
