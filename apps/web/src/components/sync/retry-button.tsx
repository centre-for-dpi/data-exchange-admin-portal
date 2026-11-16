'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { retrySyncAction } from '../../lib/sync-actions';
import { initialFormState } from '../../lib/forms';
import { errorTextClass } from '../form/field';
import { Button } from '../ui/button';

/** Reconcile one target now: the reconciler's job is queued (M5-07). */
export function RetrySyncButton({ target }: { target: string }) {
  const t = useTranslations('syncConsole');
  const [state, action, pending] = useActionState(
    retrySyncAction.bind(null, target),
    initialFormState,
  );
  return (
    <form action={action}>
      {state.formError ? <p className={errorTextClass}>{state.formError}</p> : null}
      {state.done ? (
        <p role="status" className="text-sm font-medium text-success-fg">
          {t('queued')}
        </p>
      ) : (
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-label={t('retryFor', { target })}
        >
          {t('retry')}
        </Button>
      )}
    </form>
  );
}
