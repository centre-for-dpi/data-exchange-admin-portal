'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { purgeDocumentAction } from '../../lib/document-actions';
import { type FormState, initialFormState } from '../../lib/forms';
import { checkClass, errorTextClass, ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

/** Deletion of a document's bytes by legal order; asks for the order and a confirmation. */
export function PurgeDocumentForm({ documentId, name }: { documentId: string; name: string }) {
  const t = useTranslations('documentsAdmin');
  const [state, action, pending] = useActionState(
    purgeDocumentAction.bind(null, documentId),
    initialFormState,
  );
  const field = `order-${documentId}`;
  const confirmId = `confirm-${documentId}`;
  const fieldState: FormState = {
    ...state,
    fieldErrors: state.fieldErrors?.order ? { [field]: state.fieldErrors.order } : {},
  };
  const confirmError = state.fieldErrors?.confirm?.join(' ');
  return (
    <details>
      <summary className="link cursor-pointer text-sm">{t('purge', { name })}</summary>
      <form
        action={action}
        className="mt-3 min-w-72 space-y-3"
        aria-label={t('purgeFor', { name })}
        noValidate
      >
        <ErrorSummary state={state} />
        <Field name={field} label={t('order')} hint={t('orderHint')} required state={fieldState}>
          {(p) => (
            <textarea
              {...p}
              name="order"
              rows={2}
              defaultValue={state.values?.order}
              className={inputClass}
            />
          )}
        </Field>
        <div>
          <label className="flex items-start gap-2 text-sm">
            <input
              id={confirmId}
              type="checkbox"
              name="confirm"
              className={`${checkClass} mt-0.5`}
              aria-invalid={confirmError ? true : undefined}
              aria-describedby={confirmError ? `${confirmId}-error` : undefined}
            />
            {t('confirm')}
          </label>
          {confirmError ? (
            <p id={`${confirmId}-error`} className={errorTextClass}>
              {confirmError}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {t('purgeButton')}
        </Button>
      </form>
    </details>
  );
}
