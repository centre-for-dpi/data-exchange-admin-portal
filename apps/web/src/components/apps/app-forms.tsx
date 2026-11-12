'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Link } from '../../i18n/navigation';
import {
  type CreateApplicationState,
  createApplicationAction,
} from '../../lib/application-actions';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations('myApps.secret');
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`${t('copy')} ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? t('copied') : t('copy')}
    </Button>
  );
}

/** Shows the client secret right after creation. It is never shown again (SPEC.md §4.3). */
function SecretReveal({ created }: { created: NonNullable<CreateApplicationState['created']> }) {
  const t = useTranslations('myApps.secret');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="space-y-5" aria-labelledby="secret-heading">
      <h2 id="secret-heading" ref={heading} tabIndex={-1} className="text-2xl font-bold">
        {t('title')}
      </h2>
      <p
        role="alert"
        className="rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-sm font-medium text-danger-fg"
      >
        {t('warning')}
      </p>
      <dl className="space-y-4 text-sm">
        <div>
          <dt>{t('clientId')}</dt>
          <dd className="mt-1.5 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface-app py-2 pr-2 pl-4">
            <code data-testid="client-id" className="flex-1 break-all">
              {created.clientId}
            </code>
            <CopyButton value={created.clientId} label={t('clientId')} />
          </dd>
        </div>
        <div>
          <dt>{t('clientSecret')}</dt>
          <dd className="mt-1.5 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface-app py-2 pr-2 pl-4">
            <code data-testid="client-secret" className="flex-1 break-all">
              {created.clientSecret}
            </code>
            <CopyButton value={created.clientSecret} label={t('clientSecret')} />
          </dd>
        </div>
      </dl>
      <Button asChild>
        <Link href={`/my-apps/${created.applicationId}`}>{t('continue')}</Link>
      </Button>
    </section>
  );
}

export function CreateApplicationForm() {
  const t = useTranslations('myApps');
  const [state, action, pending] = useActionState(createApplicationAction, {});
  if (state.created) return <SecretReveal created={state.created} />;
  return (
    <form action={action} className="space-y-5" noValidate>
      <ErrorSummary state={state} />
      <Field name="name" label={t('create.name')} required state={state}>
        {(p) => <input {...p} type="text" className={inputClass} />}
      </Field>
      <Field name="description" label={t('create.description')} required state={state}>
        {(p) => <textarea {...p} rows={3} className={inputClass} />}
      </Field>
      <Field name="environment" label={t('create.environment')} required state={state}>
        {(p) => (
          <select {...p} className={inputClass} defaultValue="sandbox">
            <option value="sandbox">{t('environments.sandbox')}</option>
            <option value="production">{t('environments.production')}</option>
          </select>
        )}
      </Field>
      <Field name="technicalContact" label={t('create.technicalContact')} required state={state}>
        {(p) => <input {...p} type="email" autoComplete="email" className={inputClass} />}
      </Field>
      <Button type="submit" disabled={pending}>
        {t('create.submit')}
      </Button>
    </form>
  );
}
