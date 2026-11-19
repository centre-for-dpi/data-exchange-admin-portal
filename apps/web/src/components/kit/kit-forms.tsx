'use client';

import { KIT_BUNDLE_MEDIA_TYPE } from '@den/contracts';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { type FormEvent, useActionState, useId, useState } from 'react';
import { type FormState, initialFormState } from '../../lib/forms';
import { makeKitReleaseCurrentAction, setKitReleaseAction } from '../../lib/kit-actions';
import { ErrorSummary, errorTextClass, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

export interface KitReleaseValues {
  version: string;
  url: string;
  sizeBytes: string;
  sha256: string;
  signatureUrl: string;
  allowedSigners: string;
}

/**
 * Operator: set the kit's current version, or correct one (P-03). A correction keeps the version
 * and, for a mirrored release, its size and checksum (the API refuses to change them).
 */
export function KitReleaseForm({
  initial,
  locked = false,
}: {
  initial?: KitReleaseValues;
  /** Mirrored: only the signature fields can change. */
  locked?: boolean;
}) {
  const t = useTranslations('kitAdmin.form');
  const [state, action, pending] = useActionState(setKitReleaseAction, initialFormState);
  const suffix = initial ? initial.version.replace(/[^A-Za-z0-9-]/g, '-') : 'new';
  const value = (name: keyof KitReleaseValues) => state.values?.[name] ?? initial?.[name] ?? '';
  const input = (
    name: keyof KitReleaseValues,
    label: string,
    options: { required?: boolean; readOnly?: boolean; mono?: boolean; area?: boolean } = {},
  ) => (
    <Field
      name={name}
      idSuffix={suffix}
      label={label}
      required={options.required ?? true}
      state={state}
    >
      {(p) =>
        options.area ? (
          <textarea
            {...p}
            rows={3}
            defaultValue={value(name)}
            className={`${inputClass} font-mono`}
          />
        ) : (
          <input
            {...p}
            type="text"
            defaultValue={value(name)}
            readOnly={options.readOnly}
            spellCheck={false}
            autoComplete="off"
            className={`${inputClass}${options.mono ? ' font-mono' : ''}`}
          />
        )
      }
    </Field>
  );
  return (
    <form
      action={action}
      className="space-y-4"
      noValidate
      aria-label={initial ? t('editOf', { version: initial.version }) : t('label')}
    >
      <ErrorSummary state={state} />
      {state.done ? (
        <p role="status" className="text-sm font-medium text-success-fg">
          {t('saved')}
        </p>
      ) : null}
      {input('version', t('version'), { readOnly: Boolean(initial), mono: true })}
      {input('url', t('url'), { readOnly: locked })}
      <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
        {input('sizeBytes', t('sizeBytes'), { readOnly: locked, mono: true })}
        {input('sha256', t('sha256'), { readOnly: locked, mono: true })}
      </div>
      {input('signatureUrl', t('signatureUrl'), { required: false })}
      {input('allowedSigners', t('allowedSigners'), { required: false, area: true })}
      <Button type="submit" disabled={pending} variant={initial ? 'outline' : 'default'}>
        {initial ? t('save') : t('submit')}
      </Button>
    </form>
  );
}

export function MakeKitCurrentButton({ version }: { version: string }) {
  const t = useTranslations('kitAdmin');
  const [state, action, pending] = useActionState<FormState>(
    makeKitReleaseCurrentAction.bind(null, version),
    initialFormState,
  );
  return (
    <form action={action}>
      {state.formError ? <p className={errorTextClass}>{state.formError}</p> : null}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={t('makeCurrentFor', { version })}
      >
        {t('makeCurrent')}
      </Button>
    </form>
  );
}

interface UploadProblem {
  errors?: Array<{ key?: string }>;
}

/**
 * Operator: mirror a release's bundle on the portal. The file goes straight to the web's upload
 * route (apps/web/src/app/files/kit-releases), which streams it to the API with the session's
 * token: a server action would hold the whole bundle within its body limit.
 */
export function KitBundleUploadForm({
  version,
  fileName,
  sizeBytes,
}: {
  version: string;
  fileName: string;
  sizeBytes: number;
}) {
  const t = useTranslations('kitAdmin.upload');
  const tErrors = useTranslations('apiErrors.fields');
  const tForms = useTranslations('forms');
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const file = new FormData(event.currentTarget).get('bundle');
    if (!(file instanceof File) || file.size === 0) {
      setError(t('choose'));
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/files/kit-releases/${encodeURIComponent(version)}/bundle`, {
        method: 'PUT',
        headers: { 'content-type': KIT_BUNDLE_MEDIA_TYPE },
        body: file,
      });
      if (res.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      if (res.status === 413) {
        setError(t('tooLarge'));
        return;
      }
      const problem = (await res.json().catch(() => undefined)) as UploadProblem | undefined;
      const key = problem?.errors?.find((e) => e.key)?.key;
      setError(key && tErrors.has(key) ? tErrors(key) : tForms('unexpected'));
    } catch {
      setError(tForms('unexpected'));
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <p role="status" className="text-sm font-medium text-success-fg">
        {t('done', { version })}
      </p>
    );
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-2"
      noValidate
      aria-label={t('formName', { version })}
    >
      <label htmlFor={`${id}-file`} className="block text-sm font-medium text-foreground-strong">
        {t('file', { version, file: fileName })}
      </label>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {t('hint', { bytes: format.number(sizeBytes) })}
      </p>
      <input
        id={`${id}-file`}
        name="bundle"
        type="file"
        accept=".tar.gz,.tgz,application/gzip"
        aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
        {...(error ? { 'aria-invalid': true } : {})}
        className="block text-sm"
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className={errorTextClass}>
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? t('uploading') : t('submit')}
      </Button>
    </form>
  );
}
