'use server';

import { ENTITY_ROLES, entityInvitationSchema, entityMemberSchema } from '@den/contracts';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { apiSend, type Problem } from './api';
import type { FormState } from './forms';
import { formStateFromProblem } from './problem-form-state';

const rolesOf = (formData: FormData): string[] =>
  formData
    .getAll('roles')
    .filter(
      (r): r is string => typeof r === 'string' && (ENTITY_ROLES as readonly string[]).includes(r),
    );

async function done(result: { ok: true } | { ok: false; problem?: Problem }): Promise<FormState> {
  if (!result.ok) {
    const t = await getTranslations('forms');
    return await formStateFromProblem(result.problem, t('unexpected'));
  }
  revalidatePath('/', 'layout');
  return { done: true };
}

export async function inviteMemberAction(
  entityId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = formData.get('email');
  const fullName = formData.get('fullName');
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  return done(
    await apiSend(
      'POST',
      `/entities/${entityId}/invitations`,
      {
        email: typeof email === 'string' ? email.trim() : '',
        ...(name ? { fullName: name } : {}),
        roles: rolesOf(formData),
      },
      entityInvitationSchema,
    ),
  );
}

export async function revokeInvitationAction(
  entityId: string,
  invitationId: string,
  _prev: FormState,
): Promise<FormState> {
  return done(
    await apiSend(
      'POST',
      `/entities/${entityId}/invitations/${invitationId}/revoke`,
      undefined,
      entityInvitationSchema,
    ),
  );
}

export async function updateMemberRolesAction(
  entityId: string,
  membershipId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return done(
    await apiSend(
      'PUT',
      `/entities/${entityId}/members/${membershipId}/roles`,
      { roles: rolesOf(formData) },
      entityMemberSchema,
    ),
  );
}

export async function revokeMemberAction(
  entityId: string,
  membershipId: string,
  _prev: FormState,
): Promise<FormState> {
  return done(
    await apiSend(
      'POST',
      `/entities/${entityId}/members/${membershipId}/revoke`,
      undefined,
      entityMemberSchema,
    ),
  );
}
