'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { type FormState, initialFormState } from '../../lib/forms';
import {
  approveRequestAction,
  rejectRequestAction,
  requestAccessAction,
  revokeSubscriptionAction,
  type SubscriptionStep,
  subscriptionStepAction,
  uploadAgreementAction,
} from '../../lib/subscription-actions';
import { ErrorSummary, Field, checkClass, errorTextClass, inputClass } from '../form/field';
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
      <legend className="mb-1 text-sm font-medium text-foreground-strong">{legend}</legend>
      {hint ? (
        <p id={`${name}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <ul className="space-y-2">
        {operations.map((o) => (
          <li key={o.operationId}>
            <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-border-control bg-background px-4 py-3 text-sm has-[:checked]:border-primary-ink has-[:checked]:bg-primary-soft">
              <input
                type="checkbox"
                className={checkClass}
                name={name}
                value={o.operationId}
                defaultChecked={checked.includes(o.operationId)}
              />
              {/* Long paths wrap anywhere: nothing scrolls sideways at 320 px (WCAG 1.4.10). */}
              <span className="font-mono [overflow-wrap:anywhere]">
                {o.method} {o.path}
              </span>
              <span className="text-muted-foreground [overflow-wrap:anywhere]">
                ({o.operationId})
              </span>
            </label>
          </li>
        ))}
      </ul>
      {errors.length ? (
        <p id={`${name}-error`} className={errorTextClass}>
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
  prefill,
}: {
  apiVersionId: string;
  applications: ReadonlyArray<{ id: string; name: string }>;
  purposes: ReadonlyArray<{ code: string; label: string }>;
  operations: readonly OperationOption[];
  maxMonths: number;
  /** Renewal (SPEC.md §4.4 step 6): the subscription renewed and what it had (M2-06). */
  prefill?: {
    renewsSubscriptionId: string;
    purposeDetail: string;
    legalBasisText: string;
    legalReference: string | null;
    requestedOperations: readonly string[];
    requestedRateLimit: number | null;
  };
}) {
  const t = useTranslations('subscriptions.form');
  const [state, action, pending] = useActionState(
    requestAccessAction.bind(null, apiVersionId),
    initialFormState,
  );
  return (
    <form action={action} className="space-y-5" noValidate>
      <ErrorSummary state={state} />
      {prefill ? (
        <input type="hidden" name="renewsSubscriptionId" value={prefill.renewsSubscriptionId} />
      ) : null}
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
        {(p) => (
          <textarea {...p} rows={3} defaultValue={prefill?.purposeDetail} className={inputClass} />
        )}
      </Field>
      <Field
        name="legalBasisText"
        label={t('legalBasis')}
        hint={t('legalBasisHint')}
        required
        state={state}
      >
        {(p) => (
          <textarea {...p} rows={2} defaultValue={prefill?.legalBasisText} className={inputClass} />
        )}
      </Field>
      <Field name="legalReference" label={t('legalReference')} state={state}>
        {(p) => (
          <input
            {...p}
            type="text"
            defaultValue={prefill?.legalReference ?? ''}
            className={inputClass}
          />
        )}
      </Field>
      <OperationChecks
        name="requestedOperations"
        legend={t('operations')}
        hint={t('operationsHint')}
        operations={operations}
        checked={prefill?.requestedOperations ?? []}
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
        {(p) => (
          <input
            {...p}
            type="number"
            min={1}
            defaultValue={prefill?.requestedRateLimit ?? undefined}
            className={inputClass}
          />
        )}
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
    <div className="grid gap-8 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border">
      <form action={approve} className="space-y-4 md:pr-8" aria-label={t('approve')} noValidate>
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
      <form action={reject} className="space-y-4 md:pl-8" aria-label={t('reject')} noValidate>
        <ErrorSummary state={rejectState} />
        <Field name="comment" label={t('rejectComment')} required state={rejectState}>
          {(p) => <textarea {...p} rows={3} className={inputClass} />}
        </Field>
        <Button type="submit" variant="danger" disabled={busy}>
          {t('reject')}
        </Button>
      </form>
    </div>
  );
}

/** Data steward: revoke an approved or active subscription, with a reason (M1-10). */
export function RevokeForm({ subscriptionId }: { subscriptionId: string }) {
  const t = useTranslations('subscriptions.decide');
  const [state, action, pending] = useActionState(
    revokeSubscriptionAction.bind(null, subscriptionId),
    initialFormState,
  );
  return (
    <form action={action} className="space-y-4" aria-label={t('revoke')} noValidate>
      <ErrorSummary state={state} />
      <p className="text-sm text-muted-foreground">{t('revokeHint')}</p>
      <Field name="comment" label={t('revokeComment')} required state={state}>
        {(p) => <textarea {...p} rows={3} className={inputClass} />}
      </Field>
      <Button type="submit" variant="danger" disabled={pending}>
        {t('revoke')}
      </Button>
    </form>
  );
}

/**
 * One lifecycle step on a subscription (M2-06): ask for or provide information, withdraw,
 * suspend or reactivate. Fields beyond `comment` are optional corrections (provide-info).
 */
export function LifecycleForm({
  side,
  subscriptionId,
  step,
  label,
  hint,
  commentLabel,
  commentRequired,
  variant = 'default',
  corrections,
}: {
  side: 'provider' | 'consumer';
  subscriptionId: string;
  step: SubscriptionStep;
  label: string;
  hint?: string;
  commentLabel: string;
  commentRequired: boolean;
  variant?: 'default' | 'outline' | 'danger';
  corrections?: { purposeDetail: string; legalBasisText: string };
}) {
  const t = useTranslations('subscriptions.form');
  const [state, action, pending] = useActionState(
    subscriptionStepAction.bind(null, side, subscriptionId, step),
    initialFormState,
  );
  const field = `${step}-comment`;
  const fieldState: FormState = {
    ...state,
    fieldErrors: {
      ...state.fieldErrors,
      ...(state.fieldErrors?.comment ? { [field]: state.fieldErrors.comment } : {}),
    },
  };
  return (
    <form action={action} className="space-y-4" aria-label={label} noValidate>
      <ErrorSummary state={state} />
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      <Field name={field} label={commentLabel} required={commentRequired} state={fieldState}>
        {(p) => <textarea {...p} name="comment" rows={3} className={inputClass} />}
      </Field>
      {corrections ? (
        <>
          <Field name="purposeDetail" label={t('purposeDetail')} state={state}>
            {(p) => (
              <textarea
                {...p}
                rows={3}
                defaultValue={corrections.purposeDetail}
                className={inputClass}
              />
            )}
          </Field>
          <Field name="legalBasisText" label={t('legalBasis')} state={state}>
            {(p) => (
              <textarea
                {...p}
                rows={2}
                defaultValue={corrections.legalBasisText}
                className={inputClass}
              />
            )}
          </Field>
        </>
      ) : null}
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
    </form>
  );
}

/** The requester attaches the exchange agreement (PDF) to a pending request (M2-07). */
export function AgreementUploadForm({
  subscriptionId,
  hasAgreement,
}: {
  subscriptionId: string;
  hasAgreement: boolean;
}) {
  const t = useTranslations('subscriptions.agreement');
  const [state, action, pending] = useActionState(
    uploadAgreementAction.bind(null, subscriptionId),
    initialFormState,
  );
  return (
    <form action={action} className="space-y-4" noValidate>
      <ErrorSummary state={state} />
      <Field
        name="document"
        label={hasAgreement ? t('replace') : t('label')}
        hint={t('hint')}
        required
        state={state}
      >
        {(p) => <input {...p} type="file" accept="application/pdf,.pdf" className={inputClass} />}
      </Field>
      <Button type="submit" variant="outline" disabled={pending}>
        {t('upload')}
      </Button>
    </form>
  );
}
