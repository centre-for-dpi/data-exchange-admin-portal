'use client';

import { DESIGNEE_ROLES, ENTITY_KINDS, type EntityRequest } from '@rid/contracts';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import {
  acceptInvitationAction,
  createEntityDirectAction,
  createEntityRequestAction,
  decideEntityRequestAction,
  declineInvitationAction,
  submitEntityRequestAction,
  updateEntityRequestAction,
  uploadDesignationAction,
} from '../../lib/entity-request-actions';
import { type FormState, initialFormState } from '../../lib/forms';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

export interface Option {
  value: string;
  label: string;
}

function TextField({
  name,
  label,
  hint,
  state,
  defaultValue,
  type = 'text',
  required = true,
  autoComplete,
}: {
  name: string;
  label: string;
  hint?: string;
  state: FormState;
  defaultValue?: string | null;
  type?: 'text' | 'email' | 'url';
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <Field name={name} label={label} hint={hint} required={required} state={state}>
      {(p) => (
        <input
          {...p}
          type={type}
          defaultValue={state.values?.[name] ?? defaultValue ?? ''}
          autoComplete={autoComplete ?? 'off'}
          className={inputClass}
        />
      )}
    </Field>
  );
}

function SelectField({
  name,
  label,
  options,
  state,
  defaultValue,
}: {
  name: string;
  label: string;
  options: Option[];
  state: FormState;
  defaultValue?: string;
}) {
  return (
    <Field name={name} label={label} required state={state}>
      {(p) => (
        <select
          {...p}
          defaultValue={state.values?.[name] ?? defaultValue ?? options[0]?.value}
          className={inputClass}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/**
 * The onboarding request (SPEC.md §4.1): entity data, data protection officer and the two
 * responsibilities that will be invited on approval. Used to create and to correct a request,
 * and (`direct`) by the operator to register an entity at once, with its administrator and
 * the act that grounds it.
 */
export function EntityRequestForm({
  locale,
  sectors,
  taxIdTypes,
  request,
  direct = false,
}: {
  locale: string;
  sectors: Option[];
  taxIdTypes: string[];
  request?: EntityRequest;
  direct?: boolean;
}) {
  const t = useTranslations('entityRequests.form');
  const tk = useTranslations('entityKind');
  const td = useTranslations('entityAdmin.create');
  const action = direct
    ? createEntityDirectAction.bind(null, locale)
    : request
      ? updateEntityRequestAction.bind(null, request.id, locale)
      : createEntityRequestAction.bind(null, locale);
  const [state, formAction, pending] = useActionState(action, initialFormState);
  const designee = (role: (typeof DESIGNEE_ROLES)[number]) =>
    request?.designees.find((d) => d.role === role);

  return (
    <form action={formAction} className="space-y-8" noValidate>
      <ErrorSummary state={state} />
      <fieldset className="space-y-5">
        <legend className="text-xl font-bold">{t('entity')}</legend>
        <TextField
          name="legalName"
          label={t('legalName')}
          state={state}
          defaultValue={request?.legalName}
        />
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            name="shortName"
            label={t('shortName')}
            hint={t('shortNameHint')}
            state={state}
            defaultValue={request?.shortName}
          />
          <TextField
            name="slug"
            label={t('slug')}
            hint={t('slugHint')}
            state={state}
            defaultValue={request?.slug}
          />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <SelectField
            name="taxIdType"
            label={t('taxIdType')}
            options={taxIdTypes.map((v) => ({ value: v, label: v }))}
            state={state}
            defaultValue={request?.taxIdType}
          />
          <TextField name="taxId" label={t('taxId')} state={state} defaultValue={request?.taxId} />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <SelectField
            name="kind"
            label={t('kind')}
            options={ENTITY_KINDS.map((k) => ({ value: k, label: tk(k) }))}
            state={state}
            defaultValue={request?.kind}
          />
          <SelectField
            name="sector"
            label={t('sector')}
            options={sectors}
            state={state}
            defaultValue={request?.sector}
          />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            name="contactEmail"
            type="email"
            label={t('contactEmail')}
            state={state}
            defaultValue={request?.contactEmail}
          />
          <TextField
            name="website"
            type="url"
            label={t('website')}
            hint={t('websiteHint')}
            required={false}
            state={state}
            defaultValue={request?.website}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-5">
        <legend className="text-xl font-bold">{t('dpo')}</legend>
        <p className="text-sm text-muted-foreground">{t('dpoHint')}</p>
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            name="dpoName"
            label={t('fullName')}
            state={state}
            defaultValue={request?.dpoName}
          />
          <TextField
            name="dpoEmail"
            type="email"
            label={t('email')}
            state={state}
            defaultValue={request?.dpoEmail}
          />
        </div>
      </fieldset>

      {DESIGNEE_ROLES.map((role) => (
        <fieldset key={role} className="space-y-5">
          <legend className="text-xl font-bold">{t(`designee.${role}.title`)}</legend>
          <p className="text-sm text-muted-foreground">{t(`designee.${role}.hint`)}</p>
          <div className="grid gap-5 md:grid-cols-2">
            <TextField
              name={`designees.${role}.fullName`}
              label={t('fullName')}
              state={state}
              defaultValue={designee(role)?.fullName}
            />
            <TextField
              name={`designees.${role}.email`}
              type="email"
              label={t('email')}
              state={state}
              defaultValue={designee(role)?.email}
            />
          </div>
        </fieldset>
      ))}

      {direct ? (
        <>
          <fieldset className="space-y-5">
            <legend className="text-xl font-bold">{td('admin')}</legend>
            <p className="text-sm text-muted-foreground">{td('adminHint')}</p>
            <div className="grid gap-5 md:grid-cols-2">
              <TextField name="admin.fullName" label={t('fullName')} state={state} />
              <TextField name="admin.email" type="email" label={t('email')} state={state} />
            </div>
          </fieldset>
          <fieldset className="space-y-5">
            <legend className="text-xl font-bold">{td('basisTitle')}</legend>
            <Field name="basis" label={td('basis')} hint={td('basisHint')} required state={state}>
              {(p) => (
                <textarea
                  {...p}
                  rows={3}
                  defaultValue={state.values?.basis ?? ''}
                  className={inputClass}
                />
              )}
            </Field>
          </fieldset>
        </>
      ) : null}

      <Button type="submit" disabled={pending}>
        {direct ? td('submit') : request ? t('save') : t('create')}
      </Button>
    </form>
  );
}

/** Attaches the designation document (PDF). */
export function DesignationUpload({
  requestId,
  hasDocument,
}: {
  requestId: string;
  hasDocument: boolean;
}) {
  const t = useTranslations('entityRequests.document');
  const [state, action, pending] = useActionState(
    uploadDesignationAction.bind(null, requestId),
    initialFormState,
  );
  return (
    <form action={action} className="space-y-4" noValidate>
      <ErrorSummary state={state} />
      <Field
        name="document"
        label={hasDocument ? t('replace') : t('label')}
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

export function SubmitRequestForm({ requestId }: { requestId: string }) {
  const t = useTranslations('entityRequests.detail');
  const [state, action, pending] = useActionState(
    submitEntityRequestAction.bind(null, requestId),
    initialFormState,
  );
  return (
    <form action={action} className="space-y-4">
      <ErrorSummary state={state} />
      {state.fieldErrors?.designationDocument ? (
        <p className="text-sm font-medium text-danger-fg">{t('documentMissing')}</p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {t('submit')}
      </Button>
    </form>
  );
}

function DecisionForm({
  requestId,
  decision,
  label,
  commentLabel,
  commentRequired,
  variant,
}: {
  requestId: string;
  decision: 'approve' | 'request-changes' | 'reject';
  label: string;
  commentLabel: string;
  commentRequired: boolean;
  variant: 'default' | 'outline' | 'danger';
}) {
  const [state, action, pending] = useActionState(
    decideEntityRequestAction.bind(null, requestId, decision),
    initialFormState,
  );
  // Three comment fields on one page: each gets its own id, errors of `comment` included.
  const field = `comment-${decision}`;
  const fieldState: FormState = {
    ...state,
    fieldErrors: state.fieldErrors?.comment ? { [field]: state.fieldErrors.comment } : {},
  };
  return (
    <form action={action} className="space-y-4" aria-label={label} noValidate>
      <ErrorSummary state={state} />
      <Field name={field} label={commentLabel} required={commentRequired} state={fieldState}>
        {(p) => <textarea {...p} name="comment" rows={3} className={inputClass} />}
      </Field>
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
    </form>
  );
}

/** Operator decision on an onboarding request. */
export function EntityDecisionForms({ requestId }: { requestId: string }) {
  const t = useTranslations('entityRequests.review');
  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <DecisionForm
        requestId={requestId}
        decision="approve"
        label={t('approve')}
        commentLabel={t('approveComment')}
        commentRequired={false}
        variant="default"
      />
      <DecisionForm
        requestId={requestId}
        decision="request-changes"
        label={t('requestChanges')}
        commentLabel={t('changesComment')}
        commentRequired
        variant="outline"
      />
      <DecisionForm
        requestId={requestId}
        decision="reject"
        label={t('reject')}
        commentLabel={t('rejectComment')}
        commentRequired
        variant="danger"
      />
    </div>
  );
}

export function InvitationActions({
  invitationId,
  locale,
  entityName,
}: {
  invitationId: string;
  locale: string;
  entityName: string;
}) {
  const t = useTranslations('invitations');
  const [acceptState, accept, accepting] = useActionState(
    acceptInvitationAction.bind(null, invitationId, locale),
    initialFormState,
  );
  const [declineState, decline, declining] = useActionState(
    declineInvitationAction.bind(null, invitationId),
    initialFormState,
  );
  return (
    <div className="flex flex-wrap items-start gap-3">
      <ErrorSummary state={acceptState.formError ? acceptState : declineState} />
      <form action={accept}>
        <Button
          type="submit"
          disabled={accepting || declining}
          aria-label={t('acceptFor', { entity: entityName })}
        >
          {t('accept')}
        </Button>
      </form>
      <form action={decline}>
        <Button
          type="submit"
          variant="outline"
          disabled={accepting || declining}
          aria-label={t('declineFor', { entity: entityName })}
        >
          {t('decline')}
        </Button>
      </form>
    </div>
  );
}
