'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { type FormState, initialFormState } from '../../lib/forms';
import {
  approveRequestAction,
  rejectRequestAction,
  requestAccessAction,
} from '../../lib/subscription-actions';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

export interface OperationOption {
  operationId: string;
  method: string;
  path: string;
}

/** Group of checkboxes with a legend, hint and errors (WCAG 1.3.1, 3.3.1). */
function OperationChecks({
  name,
  legend,
  hint,
  operations,
  checked,
  state,
}: {
  name: string;
  legend: string;
  hint?: string;
  operations: readonly OperationOption[];
  checked: readonly string[];
  state: FormState;
}) {
  const errors = state.fieldErrors?.[name] ?? [];
  const describedBy = [hint ? `${name}-hint` : '', errors.length ? `${name}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <fieldset
      className="space-y-2"
      aria-describedby={describedBy || undefined}
      aria-invalid={errors.length ? true : undefined}
    >
      <legend className="text-sm font-medium">{legend}</legend>
      {hint ? (
        <p id={`${name}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <ul className="space-y-1">
        {operations.map((o) => (
          <li key={o.operationId}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={name}
                value={o.operationId}
                defaultChecked={checked.includes(o.operationId)}
              />
              <span className="font-mono">
                {o.method} {o.path}
              </span>
              <span className="text-muted-foreground">({o.operationId})</span>
            </label>
          </li>
        ))}
      </ul>
      {errors.length ? (
        <p id={`${name}-error`} className="text-sm text-red-700">
          {errors.join(' ')}
        </p>
      ) : null}
    </fieldset>
  );
}

export function RequestAccessForm({
  apiVersionId,
  applications,
  purposes,
  operations,
  maxMonths,
}: {
  apiVersionId: string;
  applications: ReadonlyArray<{ id: string; name: string }>;
  purposes: ReadonlyArray<{ code: string; label: string }>;
  operations: readonly OperationOption[];
  maxMonths: number;
}) {
  const t = useTranslations('subscriptions.form');
  const [state, action, pending] = useActionState(
    requestAccessAction.bind(null, apiVersionId),
    initialFormState,
  );
  return (
    <form action={action} className="max-w-2xl space-y-5" noValidate>
      <ErrorSummary state={state} />
      <Field name="applicationId" label={t('application')} required state={state}>
        {(p) => (
          <select {...p} className={inputClass}>
            {applications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field name="purposeCode" label={t('purpose')} required state={state}>
        {(p) => (
          <select {...p} className={inputClass}>
            {purposes.map((purpose) => (
              <option key={purpose.code} value={purpose.code}>
                {purpose.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        name="purposeDetail"
        label={t('purposeDetail')}
        hint={t('purposeDetailHint')}
        required
        state={state}
      >
        {(p) => <textarea {...p} rows={3} className={inputClass} />}
      </Field>
      <Field
        name="legalBasisText"
        label={t('legalBasis')}
        hint={t('legalBasisHint')}
        required
        state={state}
      >
        {(p) => <textarea {...p} rows={2} className={inputClass} />}
      </Field>
      <Field name="legalReference" label={t('legalReference')} state={state}>
        {(p) => <input {...p} type="text" className={inputClass} />}
      </Field>
      <OperationChecks
        name="requestedOperations"
        legend={t('operations')}
        hint={t('operationsHint')}
        operations={operations}
        checked={[]}
        state={state}
      />
      <Field
        name="validityMonths"
        label={t('validityMonths')}
        hint={t('validityHint', { max: maxMonths })}
        required
        state={state}
      >
        {(p) => (
          <input
            {...p}
            type="number"
            min={1}
            max={maxMonths}
            defaultValue={maxMonths}
            className={inputClass}
          />
        )}
      </Field>
      <Field name="requestedRateLimit" label={t('rateLimit')} state={state}>
        {(p) => <input {...p} type="number" min={1} className={inputClass} />}
      </Field>
      <Button type="submit" disabled={pending}>
        {t('submit')}
      </Button>
    </form>
  );
}

/** Data steward decision: approve (narrowing only) or reject with a reason. */
export function RequestDecisionForms({
  subscriptionId,
  operations,
  requested,
  requestedMonths,
  rateLimit,
}: {
  subscriptionId: string;
  /** Operations the consumer asked for (the empty request already expanded). */
  operations: readonly OperationOption[];
  requested: readonly string[];
  requestedMonths: number;
  rateLimit: number | null;
}) {
  const t = useTranslations('subscriptions.decide');
  const [approveState, approve, approving] = useActionState(
    approveRequestAction.bind(null, subscriptionId),
    initialFormState,
  );
  const [rejectState, reject, rejecting] = useActionState(
    rejectRequestAction.bind(null, subscriptionId),
    initialFormState,
  );
  const busy = approving || rejecting;
  return (
    <div className="grid gap-8 md:grid-cols-2">
      <form action={approve} className="space-y-4" aria-label={t('approve')} noValidate>
        <ErrorSummary state={approveState} />
        <p className="text-sm text-muted-foreground">{t('approveHint')}</p>
        <OperationChecks
          name="approvedOperations"
          legend={t('operations')}
          operations={operations.filter((o) => requested.includes(o.operationId))}
          checked={requested}
          state={approveState}
        />
        <Field name="validityMonths" label={t('validityMonths')} required state={approveState}>
          {(p) => (
            <input
              {...p}
              type="number"
              min={1}
              max={requestedMonths}
              defaultValue={requestedMonths}
              className={inputClass}
            />
          )}
        </Field>
        <Field name="rateLimitPerMinute" label={t('rateLimit')} state={approveState}>
          {(p) => (
            <input
              {...p}
              type="number"
              min={1}
              defaultValue={rateLimit ?? undefined}
              className={inputClass}
            />
          )}
        </Field>
        <Field name="approveComment" label={t('approveComment')} state={approveState}>
          {(p) => <textarea {...p} name="comment" rows={2} className={inputClass} />}
        </Field>
        <Button type="submit" disabled={busy}>
          {t('approve')}
        </Button>
      </form>
      <form action={reject} className="space-y-4" aria-label={t('reject')} noValidate>
        <ErrorSummary state={rejectState} />
        <Field name="comment" label={t('rejectComment')} required state={rejectState}>
          {(p) => <textarea {...p} rows={3} className={inputClass} />}
        </Field>
        <Button type="submit" variant="outline" disabled={busy}>
          {t('reject')}
        </Button>
      </form>
    </div>
  );
}
