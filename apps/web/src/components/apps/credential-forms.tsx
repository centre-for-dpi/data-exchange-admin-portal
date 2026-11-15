'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { revokeCredentialAction, rotateSecretAction } from '../../lib/application-actions';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';
import { CopyButton } from './app-forms';

/**
 * Rotates the client secret (M3-04). The new secret is shown once, here; the previous one keeps
 * working until the date shown, so the consumer can switch without downtime.
 */
export function RotateSecretForm({ applicationId, days }: { applicationId: string; days: number }) {
  const t = useTranslations('myApps.rotation');
  const ts = useTranslations('myApps.secret');
  const format = useFormatter();
  const [state, action, pending] = useActionState(rotateSecretAction, {});
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.rotated) heading.current?.focus();
  }, [state.rotated]);

  if (state.rotated) {
    const until = state.rotated.previousWorksUntil;
    return (
      <section className="space-y-4" aria-labelledby="rotated-secret-heading">
        <h3
          id="rotated-secret-heading"
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold"
        >
          {t('newSecretTitle')}
        </h3>
        <p
          role="alert"
          className="rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-sm font-medium text-danger-fg"
        >
          {t('newSecretWarning', {
            date: until ? format.dateTime(new Date(until), { dateStyle: 'long' }) : '',
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface-app py-2 pr-2 pl-4 text-sm">
          <code data-testid="rotated-secret" className="flex-1 break-all">
            {state.rotated.clientSecret}
          </code>
          <CopyButton value={state.rotated.clientSecret} label={ts('clientSecret')} />
        </div>
      </section>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <ErrorSummary state={state} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <p className="text-sm text-muted-foreground">{t('rotateSecretHint', { days })}</p>
      <Button type="submit" variant="outline" disabled={pending}>
        {t('rotateSecret')}
      </Button>
    </form>
  );
}

/** Revokes a credential (M3-04): it stops working at once; the reason goes to the audit trail. */
export function RevokeCredentialForm({
  applicationId,
  credentialId,
  label,
}: {
  applicationId: string;
  credentialId: string;
  /** What is revoked, for the accessible names ("certificado 1a2b…"). */
  label: string;
}) {
  const t = useTranslations('myApps.rotation');
  const [state, action, pending] = useActionState(revokeCredentialAction, {});
  if (state.done) {
    return (
      <Notice tone="success" role="status">
        {t('revoked')}
      </Notice>
    );
  }
  return (
    <details className="w-full text-sm">
      <summary className="cursor-pointer font-medium text-danger-fg">
        {t('revokeLabel', { what: label })}
      </summary>
      <form action={action} className="mt-3 space-y-3">
        <ErrorSummary state={state} />
        <input type="hidden" name="applicationId" value={applicationId} />
        <input type="hidden" name="credentialId" value={credentialId} />
        <p>{t('revokeWarning')}</p>
        <Field name="reason" label={t('revokeReason')} state={state} idSuffix={credentialId}>
          {(p) => (
            <input
              {...p}
              type="text"
              maxLength={500}
              defaultValue={state.values?.reason}
              className={inputClass}
            />
          )}
        </Field>
        <Button type="submit" variant="danger" size="sm" disabled={pending}>
          {t('revokeConfirm')}
        </Button>
      </form>
    </details>
  );
}
