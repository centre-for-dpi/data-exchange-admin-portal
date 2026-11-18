'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import { initialFormState } from '../../lib/forms';
import { approveVersionAction, requestChangesAction } from '../../lib/review-actions';
import type { ApprovalBlock } from '../../lib/validation-hints';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';

/**
 * Operator decision on a version: approve (optional comment) or request changes (comment).
 * Approve is disabled, with the reason next to it, while the automatic validations have not
 * passed (P-07); the API refuses it the same way (409), and that refusal shows as an error.
 */
export function DecisionForms({
  versionId,
  approvalBlock = null,
}: {
  versionId: string;
  approvalBlock?: ApprovalBlock | null;
}) {
  const t = useTranslations('operator.review');
  const blockedId = useId();
  const [approveState, approve, approving] = useActionState(
    approveVersionAction.bind(null, versionId),
    initialFormState,
  );
  const [changesState, requestChanges, requesting] = useActionState(
    requestChangesAction.bind(null, versionId),
    initialFormState,
  );
  return (
    <div className="grid gap-8 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border">
      <form action={approve} className="space-y-4 md:pr-8" aria-label={t('approve')} noValidate>
        <ErrorSummary state={approveState} />
        <Field name="approveComment" label={t('approveComment')} state={approveState}>
          {(p) => <textarea {...p} name="comment" rows={3} className={inputClass} />}
        </Field>
        {approvalBlock ? (
          <Notice
            id={blockedId}
            tone={approvalBlock === 'failed' ? 'danger' : 'warning'}
            data-testid="approve-blocked"
          >
            {t(`approveBlocked.${approvalBlock}`)}
          </Notice>
        ) : null}
        <Button
          type="submit"
          disabled={approving || requesting || approvalBlock !== null}
          aria-describedby={approvalBlock ? blockedId : undefined}
        >
          {t('approve')}
        </Button>
      </form>
      <form
        action={requestChanges}
        className="space-y-4 md:pl-8"
        aria-label={t('requestChanges')}
        noValidate
      >
        <ErrorSummary state={changesState} />
        <Field name="comment" label={t('changesComment')} required state={changesState}>
          {(p) => <textarea {...p} rows={3} className={inputClass} />}
        </Field>
        <Button type="submit" variant="outline" disabled={approving || requesting}>
          {t('requestChanges')}
        </Button>
      </form>
    </div>
  );
}
