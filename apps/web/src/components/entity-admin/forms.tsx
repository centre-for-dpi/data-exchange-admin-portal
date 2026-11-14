'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { decideEntityStatusAction, type EntityDecision } from '../../lib/entity-admin-actions';
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
