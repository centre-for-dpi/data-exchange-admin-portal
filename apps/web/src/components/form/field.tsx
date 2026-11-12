'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useRef } from 'react';
import type { FormState } from '../../lib/forms';
import { cn } from '../../lib/utils';

export const inputClass =
  'mt-1.5 block w-full rounded-[var(--radius-control)] border border-border-control bg-background px-3.5 py-2.5 text-sm text-foreground-strong shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-foreground focus-visible:border-primary-ink focus-visible:ring-4 focus-visible:ring-[var(--primary-ring)] aria-[invalid=true]:border-danger-border aria-[invalid=true]:ring-danger-bg';

/** Native checkbox / radio, tinted with the brand colour. */
export const checkClass = 'size-4 shrink-0 accent-[var(--primary-ink)]';

/** Error text under a control. */
export const errorTextClass = 'mt-1.5 text-sm font-medium text-danger-fg';

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
      <label htmlFor={id} className="block text-sm font-medium text-foreground-strong">
        {label}
        {required ? (
          <span className="font-normal text-muted-foreground"> ({t('required')})</span>
        ) : null}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-sm text-muted-foreground">
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
        <p id={`${id}-error`} className={errorTextClass}>
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
      className={cn(
        'rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-sm font-medium text-danger-fg',
      )}
    >
      {state.formError ?? t('errorSummary')}
      {hasFieldErrors && state.formError ? <p>{t('errorSummary')}</p> : null}
    </div>
  );
}
