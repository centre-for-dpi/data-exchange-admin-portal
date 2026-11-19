'use client';

import { PLATFORM_ROLES } from '@den/contracts';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { type FormState, initialFormState } from '../../lib/forms';
import {
  grantPlatformRoleAction,
  revokePlatformRoleAction,
  setAccountStatusAction,
} from '../../lib/platform-user-actions';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';

/** Grant a platform role to a person who registered and signed in once (M-03). */
export function GrantRoleForm() {
  const t = useTranslations('platformUsers');
  const [state, action, pending] = useActionState(grantPlatformRoleAction, initialFormState);
  return (
    <form action={action} className="card space-y-4 p-6" aria-label={t('grant.title')} noValidate>
      <ErrorSummary state={state} />
      {state.done ? (
        <Notice tone="success" role="status">
          {t(`outcome.${state.values?.outcome === 'unchanged' ? 'unchanged' : 'granted'}`)}
        </Notice>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          name="email"
          idSuffix="grant"
          label={t('email')}
          hint={t('grant.emailHint')}
          required
          state={state}
        >
          {(p) => (
            <input
              {...p}
              type="email"
              autoComplete="off"
              defaultValue={state.done ? '' : state.values?.email}
              className={inputClass}
            />
          )}
        </Field>
        <Field name="role" idSuffix="grant" label={t('role')} required state={state}>
          {(p) => (
            <select
              {...p}
              // A select keeps its first defaultValue: remount it so a refused form shows the choice again.
              key={state.done ? 'done' : (state.values?.role ?? 'none')}
              defaultValue={state.done ? '' : (state.values?.role ?? '')}
              className={inputClass}
            >
              <option value="" disabled>
                {t('choose')}
              </option>
              {PLATFORM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field
        name="reason"
        idSuffix="grant"
        label={t('reason')}
        hint={t('reasonHint')}
        required
        state={state}
      >
        {(p) => (
          <textarea
            {...p}
            rows={2}
            defaultValue={state.done ? '' : state.values?.reason}
            className={inputClass}
          />
        )}
      </Field>
      <Button type="submit" disabled={pending}>
        {t('grant.button')}
      </Button>
    </form>
  );
}

/** Revoke one role of one holder; asks for the reason. */
export function RevokeRoleForm({
  email,
  role,
  name,
  roleLabel,
}: {
  email: string;
  role: string;
  name: string;
  roleLabel: string;
}) {
  const t = useTranslations('platformUsers');
  const [state, action, pending] = useActionState(
    revokePlatformRoleAction.bind(null, email, role),
    initialFormState,
  );
  const suffix = `${role}-${email}`;
  const fieldState: FormState = {
    ...state,
    fieldErrors: { reason: state.fieldErrors?.reason ?? [] },
  };
  return (
    <details>
      <summary className="link cursor-pointer text-sm">
        {t('revoke.open', { role: roleLabel, name })}
      </summary>
      <form
        action={action}
        className="mt-3 min-w-72 space-y-3"
        aria-label={t('revoke.form', { role: roleLabel, name })}
        noValidate
      >
        <ErrorSummary state={state} />
        <Field
          name="reason"
          idSuffix={suffix}
          label={t('reason')}
          hint={t('reasonHint')}
          required
          state={fieldState}
        >
          {(p) => (
            <textarea {...p} rows={2} defaultValue={state.values?.reason} className={inputClass} />
          )}
        </Field>
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {t('revoke.button')}
        </Button>
      </form>
    </details>
  );
}

/** Disable or enable an account by e-mail address: the compromised member, the person who left. */
export function AccountStatusForm() {
  const t = useTranslations('platformUsers');
  const [state, action, pending] = useActionState(setAccountStatusAction, initialFormState);
  return (
    <form action={action} className="card space-y-4 p-6" aria-label={t('status.title')} noValidate>
      <ErrorSummary state={state} />
      {state.done ? (
        <Notice tone="success" role="status">
          {t(`outcome.${state.values?.outcome ?? 'unchanged'}`)}
        </Notice>
      ) : null}
      <Field
        name="email"
        idSuffix="status"
        label={t('email')}
        hint={t('status.emailHint')}
        required
        state={state}
      >
        {(p) => (
          <input
            {...p}
            type="email"
            autoComplete="off"
            defaultValue={state.done ? '' : state.values?.email}
            className={inputClass}
          />
        )}
      </Field>
      <Field
        name="reason"
        idSuffix="status"
        label={t('reason')}
        hint={t('reasonHint')}
        required
        state={state}
      >
        {(p) => (
          <textarea
            {...p}
            rows={2}
            defaultValue={state.done ? '' : state.values?.reason}
            className={inputClass}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="intent" value="disable" variant="danger" disabled={pending}>
          {t('status.disable')}
        </Button>
        <Button type="submit" name="intent" value="enable" variant="outline" disabled={pending}>
          {t('status.enable')}
        </Button>
      </div>
    </form>
  );
}
