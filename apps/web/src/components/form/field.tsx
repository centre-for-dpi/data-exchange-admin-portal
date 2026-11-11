'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useRef } from 'react';
import type { FormState } from '../../lib/forms';
import { cn } from '../../lib/utils';

export const inputClass =
  'mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm aria-[invalid=true]:border-red-700';

/**
 * Label + control + hint + errors, wired with aria-describedby / aria-invalid (WCAG 1.3.1, 3.3.1).
 * The control is rendered by `children` with the ids it receives.
 */
export function Field({
  name,
  label,
  hint,
  required,
  state,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  state: FormState;
  children: (props: {
    id: string;
    name: string;
    required?: boolean;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const t = useTranslations('forms');
  const id = `field-${name}`;
  const errors = state.fieldErrors?.[name] ?? [];
  const describedBy = [hint ? `${id}-hint` : '', errors.length ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required ? <span className="text-muted-foreground"> ({t('required')})</span> : null}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children({
        id,
        name,
        required,
        ...(errors.length ? { 'aria-invalid': true as const } : {}),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      })}
      {errors.length ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {errors.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

/** Announces form errors and moves focus to them after a failed submission. */
export function ErrorSummary({ state }: { state: FormState }) {
  const t = useTranslations('forms');
  const ref = useRef<HTMLDivElement>(null);
  const hasFieldErrors = Object.keys(state.fieldErrors ?? {}).length > 0;
  const visible = hasFieldErrors || Boolean(state.formError);
  useEffect(() => {
    if (visible) ref.current?.focus();
  }, [state, visible]);
  if (!visible) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className={cn('rounded-md border border-red-700 bg-red-50 p-3 text-sm text-red-800')}
    >
      {state.formError ?? t('errorSummary')}
      {hasFieldErrors && state.formError ? <p>{t('errorSummary')}</p> : null}
    </div>
  );
}
