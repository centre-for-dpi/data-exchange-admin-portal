'use server';

import { platformRoleResultSchema, userStatusResultSchema } from '@den/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** What the user typed, kept after a failed submission (React resets the form after each action). */
const typed = (formData: FormData, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, text(formData, n)]));

async function failed(
  result: { ok: false; problem?: Parameters<typeof formStateFromProblem>[0] },
  values: Record<string, string>,
): Promise<FormState> {
  return {
    ...(await formStateFromProblem(result.problem, (await getTranslations('forms'))('unexpected'))),
    values,
  };
}

/** Platform admin: grant a platform role to a person with an active account (M-03). */
export async function grantPlatformRoleAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = typed(formData, ['email', 'role', 'reason']);
  const result = await apiSend(
    'POST',
    '/admin/platform-roles/grant',
    values,
    platformRoleResultSchema,
  );
  if (!result.ok) return failed(result, values);
  revalidatePath('/', 'layout');
  return { done: true, values: { outcome: result.data.outcome } };
}

/** Platform admin: take a platform role from someone (the last active administrator keeps it). */
export async function revokePlatformRoleAction(
  email: string,
  role: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = typed(formData, ['reason']);
  const result = await apiSend(
    'POST',
    '/admin/platform-roles/revoke',
    { email, role, reason: values.reason },
    platformRoleResultSchema,
  );
  if (!result.ok) return failed(result, values);
  revalidatePath('/', 'layout');
  return { done: true };
}

/** Platform admin: disable or enable a portal account; the clicked button names the change. */
export async function setAccountStatusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const values = typed(formData, ['email', 'reason']);
  const intent = text(formData, 'intent') === 'enable' ? 'enable' : 'disable';
  const result = await apiSend('POST', `/admin/users/${intent}`, values, userStatusResultSchema);
  if (!result.ok) return failed(result, values);
  revalidatePath('/', 'layout');
  return { done: true, values: { outcome: result.data.outcome } };
}
