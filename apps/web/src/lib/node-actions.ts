'use server';

import { issuedEnrollmentTokenSchema, nodeDetailSchema } from '@rid/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import { type FormState, problemToFormState } from './forms';

/** A form that may return an enrollment token, shown once (M4-01). */
export interface IssueTokenState extends FormState {
  issued?: { nodeName: string; token: string; expiresAt: string };
}

export async function createNodeAction(
  entityId: string,
  _prev: IssueTokenState,
  formData: FormData,
): Promise<IssueTokenState> {
  const name = formData.get('name');
  const value = typeof name === 'string' ? name.trim() : '';
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/nodes`,
    { name: value },
    issuedEnrollmentTokenSchema,
  );
  if (!result.ok) {
    const t = await getTranslations('forms');
    return { ...problemToFormState(result.problem, t('unexpected')), values: { name: value } };
  }
  revalidatePath('/', 'layout');
  return {
    issued: {
      nodeName: result.data.node.name,
      token: result.data.token,
      expiresAt: result.data.expiresAt,
    },
  };
}

export async function reissueTokenAction(
  entityId: string,
  nodeId: string,
  _prev: IssueTokenState,
): Promise<IssueTokenState> {
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/nodes/${nodeId}/enrollment-tokens`,
    {},
    issuedEnrollmentTokenSchema,
  );
  if (!result.ok) {
    const t = await getTranslations('forms');
    return problemToFormState(result.problem, t('unexpected'));
  }
  revalidatePath('/', 'layout');
  return {
    issued: {
      nodeName: result.data.node.name,
      token: result.data.token,
      expiresAt: result.data.expiresAt,
    },
  };
}

export async function revokeTokenAction(
  entityId: string,
  nodeId: string,
  tokenId: string,
  _prev: FormState,
): Promise<FormState> {
  const result = await apiSend(
    'POST',
    `/entities/${entityId}/nodes/${nodeId}/enrollment-tokens/${tokenId}/revoke`,
    undefined,
    nodeDetailSchema,
  );
  if (!result.ok) {
    const t = await getTranslations('forms');
    return problemToFormState(result.problem, t('unexpected'));
  }
  revalidatePath('/', 'layout');
  return { done: true };
}
