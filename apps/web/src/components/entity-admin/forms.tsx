'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import {
  decideEntityStatusAction,
  type EntityDecision,
  setXroadMemberAction,
} from '../../lib/entity-admin-actions';
import { type FormState, initialFormState } from '../../lib/forms';
import { checkClass, ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

function DecisionForm({
  entityId,
  name,
  decision,
}: {
  entityId: string;
  name: string;
  decision: EntityDecision;
}) {
  const t = useTranslations('entityAdmin');
  const [state, action, pending] = useActionState(
    decideEntityStatusAction.bind(null, entityId, decision),
    initialFormState,
  );
  const field = `${decision}-${entityId}`;
  const fieldState: FormState = {
    ...state,
    fieldErrors: state.fieldErrors?.comment ? { [field]: state.fieldErrors.comment } : {},
  };
  return (
    <form
      action={action}
      className="space-y-3"
      aria-label={t(`${decision}For`, { name })}
      noValidate
    >
      <ErrorSummary state={state} />
      <Field
        name={field}
        label={decision === 'reactivate' ? t('optionalComment') : t('reason')}
        required={decision !== 'reactivate'}
        state={fieldState}
      >
        {(p) => <textarea {...p} name="comment" rows={2} className={inputClass} />}
      </Field>
      {decision === 'suspend' ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="alsoAsProvider" className={checkClass} />
          {t('alsoAsProvider')}
        </label>
      ) : null}
      <Button
        type="submit"
        size="sm"
        variant={decision === 'reactivate' ? 'default' : 'danger'}
        disabled={pending}
      >
        {t(decision)}
      </Button>
    </form>
  );
}

/** The actions an operator has on an entity, depending on its status (M2-11). */
export function EntityStatusActions({
  entityId,
  name,
  status,
}: {
  entityId: string;
  name: string;
  status: string;
}) {
  const t = useTranslations('entityAdmin');
  if (status === 'offboarded') return null;
  return (
    <details>
      <summary className="link cursor-pointer text-sm">{t('manage', { name })}</summary>
      <div className="mt-3 min-w-72 space-y-5">
        {status === 'active' ? (
          <DecisionForm entityId={entityId} name={name} decision="suspend" />
        ) : null}
        {status === 'suspended' ? (
          <DecisionForm entityId={entityId} name={name} decision="reactivate" />
        ) : null}
        <DecisionForm entityId={entityId} name={name} decision="offboard" />
      </div>
    </details>
  );
}

/** The entity's X-Road member (M4-05): its xroad versions may only name services of it. */
export function XroadMemberForm({
  entityId,
  name,
  member,
}: {
  entityId: string;
  name: string;
  member: { memberClass: string; memberCode: string } | null;
}) {
  const t = useTranslations('entityAdmin.xroad');
  const [state, action, pending] = useActionState(
    setXroadMemberAction.bind(null, entityId),
    initialFormState,
  );
  const fieldState: FormState = {
    ...state,
    fieldErrors: state.fieldErrors?.member
      ? { [`memberCode-${entityId}`]: state.fieldErrors.member }
      : {},
  };
  return (
    <details>
      <summary className="link cursor-pointer text-sm">{t('manage', { name })}</summary>
      <form action={action} className="mt-3 space-y-3" noValidate>
        <ErrorSummary state={fieldState} />
        {state.done ? (
          <p role="status" className="text-sm font-medium text-success-fg">
            {t('saved')}
          </p>
        ) : null}
        <Field name={`memberClass-${entityId}`} label={t('memberClass')} state={fieldState}>
          {(p) => (
            <input
              {...p}
              name="memberClass"
              type="text"
              defaultValue={state.values?.memberClass ?? member?.memberClass ?? ''}
              className={inputClass}
            />
          )}
        </Field>
        <Field
          name={`memberCode-${entityId}`}
          label={t('memberCode')}
          hint={t('hint')}
          state={fieldState}
        >
          {(p) => (
            <input
              {...p}
              name="memberCode"
              type="text"
              defaultValue={state.values?.memberCode ?? member?.memberCode ?? ''}
              className={inputClass}
            />
          )}
        </Field>
        <Button type="submit" size="sm" disabled={pending}>
          {t('save')}
        </Button>
      </form>
    </details>
  );
}
