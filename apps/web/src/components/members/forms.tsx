'use client';

import { ENTITY_ROLES, type EntityRole } from '@den/contracts';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { type FormState, initialFormState } from '../../lib/forms';
import {
  inviteMemberAction,
  revokeInvitationAction,
  revokeMemberAction,
  updateMemberRolesAction,
} from '../../lib/member-actions';
import { checkClass, ErrorSummary, errorTextClass, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

/** Role checkboxes as a fieldset (WCAG 1.3.1), with the errors of `roles`. */
function RoleChoices({
  legend,
  idPrefix,
  state,
  selected = [],
}: {
  legend: string;
  idPrefix: string;
  state: FormState;
  selected?: readonly EntityRole[];
}) {
  const t = useTranslations('roles');
  const errors = state.fieldErrors?.roles ?? [];
  return (
    <fieldset
      className="space-y-2"
      aria-describedby={errors.length ? `${idPrefix}-roles-error` : undefined}
    >
      <legend className="text-sm font-medium text-foreground-strong">{legend}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {ENTITY_ROLES.map((role) => (
          <label key={role} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="roles"
              value={role}
              defaultChecked={selected.includes(role)}
              className={checkClass}
              id={`${idPrefix}-${role}`}
            />
            {t(role)}
          </label>
        ))}
      </div>
      {errors.length ? (
        <p id={`${idPrefix}-roles-error`} className={errorTextClass}>
          {errors.join(' ')}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Invite a person by e-mail (M2-02). The form clears after a successful invitation. */
export function InviteMemberForm({ entityId }: { entityId: string }) {
  const t = useTranslations('myEntity.invite');
  const [state, action, pending] = useActionState(
    inviteMemberAction.bind(null, entityId),
    initialFormState,
  );
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.done) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={action} className="space-y-5" noValidate>
      <ErrorSummary state={state} />
      {state.done ? (
        <p role="status" className="text-sm font-medium text-success-fg">
          {t('sent')}
        </p>
      ) : null}
      <div className="grid gap-5 md:grid-cols-2">
        <Field name="email" label={t('email')} required state={state}>
          {(p) => <input {...p} type="email" autoComplete="off" className={inputClass} />}
        </Field>
        <Field name="fullName" label={t('fullName')} state={state}>
          {(p) => <input {...p} type="text" autoComplete="off" className={inputClass} />}
        </Field>
      </div>
      <RoleChoices legend={t('roles')} idPrefix="invite" state={state} />
      <Button type="submit" disabled={pending}>
        {t('submit')}
      </Button>
    </form>
  );
}

export function RevokeInvitationButton({
  entityId,
  invitationId,
  email,
}: {
  entityId: string;
  invitationId: string;
  email: string;
}) {
  const t = useTranslations('myEntity.invitations');
  const [state, action, pending] = useActionState(
    revokeInvitationAction.bind(null, entityId, invitationId),
    initialFormState,
  );
  return (
    <form action={action}>
      {state.formError ? <p className={errorTextClass}>{state.formError}</p> : null}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={t('revokeFor', { email })}
      >
        {t('revoke')}
      </Button>
    </form>
  );
}

/** Roles of one member, editable by the entity_admin, and the revoke action. */
export function MemberActions({
  entityId,
  membershipId,
  name,
  roles,
}: {
  entityId: string;
  membershipId: string;
  name: string;
  roles: readonly EntityRole[];
}) {
  const t = useTranslations('myEntity.members');
  const [rolesState, saveRoles, saving] = useActionState(
    updateMemberRolesAction.bind(null, entityId, membershipId),
    initialFormState,
  );
  const [revokeState, revoke, revoking] = useActionState(
    revokeMemberAction.bind(null, entityId, membershipId),
    initialFormState,
  );
  return (
    <details className="group">
      <summary className="link cursor-pointer text-sm">{t('manage', { name })}</summary>
      <div className="mt-3 space-y-4">
        <form action={saveRoles} className="space-y-3" noValidate>
          {rolesState.formError ? (
            <p role="alert" className={errorTextClass}>
              {rolesState.formError}
            </p>
          ) : null}
          <RoleChoices
            legend={t('rolesOf', { name })}
            idPrefix={`member-${membershipId}`}
            state={rolesState}
            selected={roles}
          />
          <Button type="submit" size="sm" disabled={saving || revoking}>
            {t('saveRoles')}
          </Button>
        </form>
        <form action={revoke}>
          {revokeState.formError ? (
            <p role="alert" className={errorTextClass}>
              {revokeState.formError}
            </p>
          ) : null}
          <Button type="submit" size="sm" variant="danger" disabled={saving || revoking}>
            {t('revoke', { name })}
          </Button>
        </form>
      </div>
    </details>
  );
}
