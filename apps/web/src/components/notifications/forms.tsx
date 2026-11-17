'use client';

import type { NotificationKind } from '@den/contracts';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { initialFormState } from '../../lib/forms';
import { markAllReadAction, savePreferencesAction } from '../../lib/notification-actions';
import { checkClass, ErrorSummary } from '../form/field';
import { Button } from '../ui/button';

export function MarkAllReadForm() {
  const t = useTranslations('notifications');
  const [state, action, pending] = useActionState(markAllReadAction, initialFormState);
  return (
    <form action={action}>
      <ErrorSummary state={state} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {t('markAllRead')}
      </Button>
    </form>
  );
}

/** E-mail choices per kind (M2-08). Locked kinds are shown checked and disabled. */
export function PreferencesForm({
  items,
}: {
  items: ReadonlyArray<{ kind: NotificationKind; email: boolean; locked: boolean }>;
}) {
  const t = useTranslations('notifications');
  const [state, action, pending] = useActionState(savePreferencesAction, initialFormState);
  return (
    <form action={action} className="space-y-4" noValidate>
      <ErrorSummary state={state} />
      {state.done ? (
        <p role="status" className="text-sm font-medium text-success-fg">
          {t('preferencesSaved')}
        </p>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground-strong">{t('emailFor')}</legend>
        {items.map((item) => (
          <label key={item.kind} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="email"
              value={item.kind}
              defaultChecked={item.email}
              disabled={item.locked}
              className={`${checkClass} mt-0.5`}
            />
            <span>
              {t(`kindNames.${item.kind}`)}
              {item.locked ? (
                <span className="block text-muted-foreground">
                  {item.email ? t('lockedSecurity') : t('lockedOwnEmail')}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={pending}>
        {t('savePreferences')}
      </Button>
    </form>
  );
}
