'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
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
    <section className="max-w-2xl space-y-4" aria-labelledby="secret-heading">
      <h2 id="secret-heading" ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {t('title')}
      </h2>
      <p
        role="alert"
        className="rounded-md border border-red-700 bg-red-50 p-3 text-sm text-red-800"
      >
        {t('warning')}
      </p>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="font-medium">{t('clientId')}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code data-testid="client-id" className="break-all">
              {created.clientId}
            </code>
            <CopyButton value={created.clientId} label={t('clientId')} />
          </dd>
        </div>
        <div>
          <dt className="font-medium">{t('clientSecret')}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code data-testid="client-secret" className="break-all">
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
    <form action={action} className="max-w-2xl space-y-5" noValidate>
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

/** Refreshes the page every 2 s while the Keycloak client is being created (max. 1 minute). */
export function ProvisioningRefresher() {
  const router = useRouter();
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks > 30) clearInterval(timer);
      router.refresh();
    }, 2_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
