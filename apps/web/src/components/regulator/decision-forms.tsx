'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { type FormState, initialFormState } from '../../lib/forms';
import {
  type RegulatorDecision,
  regulatorDecideAction,
  type RegulatorTarget,
} from '../../lib/regulator-actions';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

function DecisionForm({
  target,
  id,
  decision,
  label,
  commentLabel,
  required,
  variant,
}: {
  target: RegulatorTarget;
  id: string;
  decision: RegulatorDecision;
  label: string;
  commentLabel: string;
  required: boolean;
  variant: 'default' | 'danger';
}) {
  const [state, action, pending] = useActionState(
    regulatorDecideAction.bind(null, target, id, decision),
    initialFormState,
  );
  // Two comment fields on one page: each has its own id, with the errors of `comment`.
  const field = `regulator-comment-${decision}`;
  const fieldState: FormState = {
    ...state,
    fieldErrors: state.fieldErrors?.comment ? { [field]: state.fieldErrors.comment } : {},
  };
  return (
    <form action={action} className="space-y-4" aria-label={label} noValidate>
      <ErrorSummary state={state} />
      <Field name={field} label={commentLabel} required={required} state={fieldState}>
        {(p) => <textarea {...p} name="comment" rows={3} className={inputClass} />}
      </Field>
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
    </form>
  );
}

/** Approve, or send back (versions) / reject (access requests), as the regulator (M2-04). */
export function RegulatorDecisionForms({ target, id }: { target: RegulatorTarget; id: string }) {
  const t = useTranslations('regulator.decision');
  const negative = target === 'api-versions' ? 'request-changes' : 'reject';
  return (
    <div className="grid gap-8 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border">
      <div className="md:pr-8">
        <DecisionForm
          target={target}
          id={id}
          decision="approve"
          label={t('approve')}
          commentLabel={t('approveComment')}
          required={false}
          variant="default"
        />
      </div>
      <div className="md:pl-8">
        <DecisionForm
          target={target}
          id={id}
          decision={negative}
          label={target === 'api-versions' ? t('requestChanges') : t('reject')}
          commentLabel={t('reason')}
          required
          variant="danger"
        />
      </div>
    </div>
  );
}
