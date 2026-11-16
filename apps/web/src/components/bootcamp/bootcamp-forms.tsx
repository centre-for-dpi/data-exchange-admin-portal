'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { updateBootcampItemAction } from '../../lib/bootcamp-actions';
import { initialFormState } from '../../lib/forms';
import { checkClass, ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

/** One prerequisite of the bootcamp: done or not, and a note for the operator (M4-07). */
export function BootcampItemForm({
  entityId,
  item,
  done,
  note,
  manualStepsAvoided,
}: {
  entityId: string;
  item: string;
  done: boolean;
  note: string | null;
  /** Use case only (M5-04). */
  manualStepsAvoided?: number | null;
}) {
  const t = useTranslations('bootcamp');
  const [state, action, pending] = useActionState(
    updateBootcampItemAction.bind(null, entityId, item),
    initialFormState,
  );
  return (
    <form action={action} className="space-y-3">
      <ErrorSummary state={state} />
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="done" defaultChecked={done} className={checkClass} />
        {t('markDone', { item: t(`items.${item}.title`) })}
      </label>
      <Field name="note" idSuffix={item} label={t('note')} hint={t('noteHint')} state={state}>
        {(p) => (
          <textarea
            {...p}
            rows={2}
            defaultValue={note ?? ''}
            maxLength={1000}
            className={inputClass}
          />
        )}
      </Field>
      {item === 'use_case' ? (
        <Field
          name="manualStepsAvoided"
          idSuffix={item}
          label={t('manualSteps')}
          hint={t('manualStepsHint')}
          state={state}
        >
          {(p) => (
            <input
              {...p}
              type="number"
              min={0}
              max={10000}
              step={1}
              inputMode="numeric"
              defaultValue={manualStepsAvoided ?? ''}
              className={inputClass}
            />
          )}
        </Field>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {t('save')}
      </Button>
      {state.done ? (
        <p role="status" className="text-sm font-medium text-success-fg">
          {t('saved')}
        </p>
      ) : null}
    </form>
  );
}
