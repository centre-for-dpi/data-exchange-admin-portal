'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { revokeCertificatesAction } from '../../lib/certificate-revocation-actions';
import { initialFormState } from '../../lib/forms';
import { checkClass, errorTextClass, ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

/**
 * The mass revocation of the previewed certificates (M6-07): the reason, an explicit
 * confirmation with the count, and the filters and count of the preview as hidden fields.
 */
export function CertificateRevocationForm({
  filters,
  count,
}: {
  filters: Record<string, string>;
  count: number;
}) {
  const t = useTranslations('certificateRevocations');
  const locale = useLocale();
  const [state, action, pending] = useActionState(
    revokeCertificatesAction.bind(null, locale),
    initialFormState,
  );
  const confirmError = state.fieldErrors?.confirm?.join(' ');
  return (
    <form action={action} className="card max-w-2xl space-y-4 p-6" noValidate>
      <ErrorSummary state={state} />
      {Object.entries(filters).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="expectedCount" value={count} />
      <Field name="reason" label={t('reason')} hint={t('reasonHint')} required state={state}>
        {(p) => (
          <textarea
            {...p}
            name="reason"
            rows={3}
            defaultValue={state.values?.reason}
            className={inputClass}
          />
        )}
      </Field>
      <div>
        <label className="flex items-start gap-2 text-sm">
          <input
            id="confirm"
            type="checkbox"
            name="confirm"
            className={`${checkClass} mt-0.5`}
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={confirmError ? 'confirm-error' : undefined}
          />
          {t('confirm', { count })}
        </label>
        {confirmError ? (
          <p id="confirm-error" className={errorTextClass}>
            {confirmError}
          </p>
        ) : null}
      </div>
      <Button type="submit" variant="danger" disabled={pending}>
        {t('revoke', { count })}
      </Button>
    </form>
  );
}
