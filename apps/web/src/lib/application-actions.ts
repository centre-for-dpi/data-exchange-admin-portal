'use server';

import {
  CSR_ERRORS,
  type CsrError,
  createdApplicationSchema,
  credentialSchema,
  issuedCertificateSchema,
  rotatedSecretSchema,
} from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';
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
  if (!result.ok) return await formStateFromProblem(result.problem, t('unexpected'));
  revalidatePath('/', 'layout');
  return {
    created: {
      applicationId: result.data.application.id,
      clientId: result.data.application.clientId,
      clientSecret: result.data.clientSecret,
    },
  };
}

export interface IssueCertificateState extends FormState {
  /** Present right after the CA signed the certificate. */
  issued?: { credentialId: string; serial: string };
}

const CSR_MESSAGE_KEYS = new Map<string, CsrError>(
  (Object.entries(CSR_ERRORS) as Array<[CsrError, string]>).map(([key, message]) => [message, key]),
);

/** Sends a CSR for the application; the API checks it and has the network CA sign it (M3-01). */
export async function issueCertificateAction(
  _prev: IssueCertificateState,
  formData: FormData,
): Promise<IssueCertificateState> {
  const t = await getTranslations('forms');
  const tc = await getTranslations('myApps.certificates');
  const entityId = (await getViewer()).activeEntity?.entity.id;
  const applicationId = text(formData, 'applicationId');
  const csr = text(formData, 'csr');
  if (!entityId || !applicationId) return { formError: t('unexpected') };
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/applications/${applicationId}/certificates`,
    { csr },
    issuedCertificateSchema,
  );
  if (!result.ok) {
    if (result.status === 503) return { formError: tc('unavailable'), values: { csr } };
    if (result.status === 409) return { formError: tc('conflict'), values: { csr } };
    const state = await formStateFromProblem(result.problem, t('unexpected'));
    // The API's CSR messages are stable texts (CSR_ERRORS): show them translated.
    if (state.fieldErrors?.csr) {
      state.fieldErrors.csr = state.fieldErrors.csr.map((message) => {
        const key = CSR_MESSAGE_KEYS.get(message);
        return key ? tc(`errors.${key}`) : message;
      });
    }
    return { ...state, values: { csr } };
  }
  revalidatePath('/', 'layout');
  return {
    issued: {
      credentialId: result.data.credential.id,
      serial: result.data.credential.certificate?.serial ?? '',
    },
  };
}

export interface RotateSecretState extends FormState {
  /** Present once, right after the rotation: the only time the new secret is shown. */
  rotated?: { clientSecret: string; previousWorksUntil: string | null };
}

/** Rotates the client secret (M3-04): a new one now, the previous one for a while. */
export async function rotateSecretAction(
  _prev: RotateSecretState,
  formData: FormData,
): Promise<RotateSecretState> {
  const t = await getTranslations('forms');
  const tr = await getTranslations('myApps.rotation');
  const entityId = (await getViewer()).activeEntity?.entity.id;
  const applicationId = text(formData, 'applicationId');
  if (!entityId || !applicationId) return { formError: t('unexpected') };
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/applications/${applicationId}/credentials/secret`,
    {},
    rotatedSecretSchema,
  );
  if (!result.ok) {
    if (result.status === 409) return { formError: tr('conflict') };
    return await formStateFromProblem(result.problem, t('unexpected'));
  }
  revalidatePath('/', 'layout');
  return {
    rotated: {
      clientSecret: result.data.clientSecret,
      previousWorksUntil: result.data.previous.rotationEndsAt,
    },
  };
}

/** Revokes a credential (M3-04): it stops working at once. */
export async function revokeCredentialAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const t = await getTranslations('forms');
  const tr = await getTranslations('myApps.rotation');
  const entityId = (await getViewer()).activeEntity?.entity.id;
  const applicationId = text(formData, 'applicationId');
  const credentialId = text(formData, 'credentialId');
  const reason = text(formData, 'reason');
  if (!entityId || !applicationId || !credentialId) return { formError: t('unexpected') };
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/applications/${applicationId}/credentials/${credentialId}/revoke`,
    reason ? { reason } : {},
    credentialSchema,
  );
  if (!result.ok) {
    if (result.status === 409) return { formError: tr('conflict') };
    return { ...(await formStateFromProblem(result.problem, t('unexpected'))), values: { reason } };
  }
  revalidatePath('/', 'layout');
  return { done: true };
}
