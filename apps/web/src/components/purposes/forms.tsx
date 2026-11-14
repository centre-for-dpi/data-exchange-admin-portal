'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { type FormState, initialFormState } from '../../lib/forms';
import {
  createPurposeAction,
  setPurposeActiveAction,
  setVersionPurposesAction,
  updatePurposeAction,
} from '../../lib/purpose-actions';
import { checkClass, ErrorSummary, errorTextClass, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

interface Texts {
  name: { es: string; en: string };
  description: { es: string; en: string };
  legalReference: string | null;
}

/** Create or edit a purpose of the catalogue (operator, M2-10). */
export function PurposeForm({ code, initial }: { code?: string; initial?: Texts }) {
  const t = useTranslations('purposes.form');
  const [state, action, pending] = useActionState(
    code ? updatePurposeAction.bind(null, code) : createPurposeAction,
    initialFormState,
  );
  const prefix = code ?? 'new';
  // Several purpose forms share the page: field ids carry the purpose code, errors follow them.
  const fieldState: FormState = {
    ...state,
    fieldErrors: Object.fromEntries(
      Object.entries(state.fieldErrors ?? {}).map(([k, v]) => [`${prefix}-${k}`, v]),
    ),
  };
  const input = (name: string, label: string, value: string, area = false, required = true) => (
    <Field name={`${prefix}-${name}`} label={label} required={required} state={fieldState}>
      {(p) =>
        area ? (
          <textarea {...p} name={name} rows={2} defaultValue={value} className={inputClass} />
        ) : (
          <input {...p} name={name} type="text" defaultValue={value} className={inputClass} />
        )
      }
    </Field>
  );
  return (
    <form
      action={action}
      className="space-y-4"
      noValidate
      aria-label={code ? t('editOf', { code }) : t('create')}
    >
      <ErrorSummary state={state} />
      {state.done ? (
        <p role="status" className="text-sm font-medium text-success-fg">
          {t('saved')}
        </p>
      ) : null}
      {code ? null : input('code', t('code'), '')}
      <div className="grid gap-4 md:grid-cols-2">
        {input('name.es', t('nameEs'), initial?.name.es ?? '')}
        {input('name.en', t('nameEn'), initial?.name.en ?? '')}
        {input('description.es', t('descriptionEs'), initial?.description.es ?? '', true)}
        {input('description.en', t('descriptionEn'), initial?.description.en ?? '', true)}
      </div>
      {input('legalReference', t('legalReference'), initial?.legalReference ?? '', false, false)}
      <Button type="submit" disabled={pending}>
        {code ? t('save') : t('create')}
      </Button>
    </form>
  );
}

export function PurposeActiveButton({ code, active }: { code: string; active: boolean }) {
  const t = useTranslations('purposes');
  const [state, action, pending] = useActionState(
    setPurposeActiveAction.bind(null, code, !active),
    initialFormState,
  );
  return (
    <form action={action}>
      {state.formError ? <p className={errorTextClass}>{state.formError}</p> : null}
      <Button
        type="submit"
        size="sm"
        variant={active ? 'outline' : 'default'}
        disabled={pending}
        aria-label={active ? t('deactivateFor', { code }) : t('activateFor', { code })}
      >
        {active ? t('deactivate') : t('activate')}
      </Button>
    </form>
  );
}

/** Data steward: which catalogue purposes a version allows (M2-10). */
export function VersionPurposesForm({
  apiId,
  versionId,
  options,
  selected,
}: {
  apiId: string;
  versionId: string;
  options: ReadonlyArray<{ code: string; label: string }>;
  selected: readonly string[];
}) {
  const t = useTranslations('purposes.version');
  const [state, action, pending] = useActionState(
    setVersionPurposesAction.bind(null, apiId, versionId),
    initialFormState,
  );
  const errors = state.fieldErrors?.allowedPurposes ?? [];
  return (
    <form action={action} className="space-y-4" noValidate>
      <ErrorSummary state={state} />
      {state.done ? (
        <p role="status" className="text-sm font-medium text-success-fg">
          {t('saved')}
        </p>
      ) : null}
      <fieldset
        className="space-y-2"
        aria-describedby={errors.length ? 'version-purposes-error' : undefined}
      >
        <legend className="text-sm font-medium text-foreground-strong">{t('legend')}</legend>
        {options.map((o) => (
          <label key={o.code} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="allowedPurposes"
              value={o.code}
              defaultChecked={selected.includes(o.code)}
              className={checkClass}
            />
            {o.label}
          </label>
        ))}
        {errors.length ? (
          <p id="version-purposes-error" className={errorTextClass}>
            {errors.join(' ')}
          </p>
        ) : null}
      </fieldset>
      <Button type="submit" variant="outline" disabled={pending}>
        {t('save')}
      </Button>
    </form>
  );
}
