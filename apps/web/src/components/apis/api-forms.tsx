'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import {
  createApiAction,
  createVersionAction,
  replaceOpenapiAction,
  submitVersionAction,
} from '../../lib/api-actions';
import { type FormState, initialFormState } from '../../lib/forms';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

interface Option {
  value: string;
  label: string;
  description?: string;
}

const CLASSIFICATIONS = ['public', 'internal', 'personal', 'sensitive'] as const;

export function CreateApiForm({ sectors }: { sectors: Option[] }) {
  const t = useTranslations('myApis.create');
  const tc = useTranslations('classification');
  const [state, action, pending] = useActionState(createApiAction, initialFormState);
  return (
    <form action={action} className="max-w-2xl space-y-5" noValidate>
      <ErrorSummary state={state} />
      <Field name="name" label={t('name')} required state={state}>
        {(p) => <input {...p} type="text" className={inputClass} />}
      </Field>
      <Field name="slug" label={t('slug')} hint={t('slugHint')} required state={state}>
        {(p) => <input {...p} type="text" className={inputClass} autoComplete="off" />}
      </Field>
      <Field name="summary" label={t('summary')} required state={state}>
        {(p) => <input {...p} type="text" className={inputClass} />}
      </Field>
      <Field name="description" label={t('description')} required state={state}>
        {(p) => <textarea {...p} rows={6} className={inputClass} />}
      </Field>
      <Field name="sector" label={t('sector')} required state={state}>
        {(p) => (
          <select {...p} className={inputClass}>
            {sectors.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field name="classification" label={t('classification')} required state={state}>
        {(p) => (
          <select {...p} className={inputClass} defaultValue="personal">
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {tc(c)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field name="tags" label={t('tags')} hint={t('tagsHint')} state={state}>
        {(p) => <input {...p} type="text" className={inputClass} />}
      </Field>
      <Field name="ownerContact" label={t('ownerContact')} required state={state}>
        {(p) => <input {...p} type="email" className={inputClass} autoComplete="email" />}
      </Field>
      <Button type="submit" disabled={pending}>
        {t('submit')}
      </Button>
    </form>
  );
}

interface ExposedField {
  name: string;
  personal: boolean;
  sensitive: boolean;
}

function ExposedFieldsEditor({ state }: { state: FormState }) {
  const t = useTranslations('version.create');
  const [fields, setFields] = useState<ExposedField[]>([
    { name: '', personal: true, sensitive: false },
  ]);
  const update = (index: number, patch: Partial<ExposedField>) =>
    setFields((all) => all.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  const errors = state.fieldErrors?.exposedFields ?? [];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('exposedFields')}</legend>
      <input
        type="hidden"
        name="exposedFields"
        value={JSON.stringify(fields.filter((f) => f.name.trim()))}
      />
      <ul className="space-y-2">
        {fields.map((field, index) => (
          <li key={index} className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor={`exposed-${index}`} className="block text-sm">
                {t('fieldName')}
              </label>
              <input
                id={`exposed-${index}`}
                type="text"
                value={field.name}
                onChange={(e) => update(index, { name: e.target.value })}
                className={inputClass}
              />
            </div>
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={field.personal}
                onChange={(e) => update(index, { personal: e.target.checked })}
              />
              {t('personal')}
            </label>
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={field.sensitive}
                onChange={(e) => update(index, { sensitive: e.target.checked })}
              />
              {t('sensitive')}
            </label>
            {fields.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFields((all) => all.filter((_, i) => i !== index))}
              >
                {t('removeField', { name: field.name || String(index + 1) })}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setFields((all) => [...all, { name: '', personal: true, sensitive: false }])}
      >
        {t('addField')}
      </Button>
      {errors.length ? <p className="text-sm text-red-700">{errors.join(' ')}</p> : null}
    </fieldset>
  );
}

function OpenapiInputs({ state }: { state: FormState }) {
  const t = useTranslations('version.create');
  return (
    <>
      <Field name="openapiFile" label={t('openapiFile')} state={state}>
        {(p) => (
          <input
            {...p}
            type="file"
            accept=".yaml,.yml,.json,application/json,application/yaml"
            className="mt-1 block text-sm"
          />
        )}
      </Field>
      <Field name="openapi" label={t('openapiText')} state={state}>
        {(p) => (
          <textarea
            {...p}
            name="openapiText"
            rows={6}
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        )}
      </Field>
    </>
  );
}

export function CreateVersionForm({ apiId, purposes }: { apiId: string; purposes: Option[] }) {
  const t = useTranslations('version.create');
  const [state, action, pending] = useActionState(
    createVersionAction.bind(null, apiId),
    initialFormState,
  );
  const [upstreamType, setUpstreamType] = useState<'node' | 'direct'>('node');
  const purposeErrors = state.fieldErrors?.allowedPurposes ?? [];
  return (
    <form action={action} className="max-w-2xl space-y-5" noValidate>
      <ErrorSummary state={state} />
      <Field name="version" label={t('version')} hint={t('versionHint')} required state={state}>
        {(p) => <input {...p} type="text" defaultValue="1.0" className={inputClass} />}
      </Field>
      <OpenapiInputs state={state} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('upstreamType')}</legend>
        {(['node', 'direct'] as const).map((type) => (
          <label key={type} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="upstreamType"
              value={type}
              checked={upstreamType === type}
              onChange={() => setUpstreamType(type)}
            />
            {type === 'node' ? t('upstreamNode') : t('upstreamDirect')}
          </label>
        ))}
      </fieldset>
      {upstreamType === 'node' ? (
        <Field name="upstream" label={t('servicePath')} required state={state}>
          {(p) => (
            <input {...p} name="servicePath" type="text" defaultValue="/" className={inputClass} />
          )}
        </Field>
      ) : (
        <>
          <Field name="upstream" label={t('url')} required state={state}>
            {(p) => <input {...p} name="url" type="url" className={inputClass} />}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="mtls" />
            {t('mtls')}
          </label>
        </>
      )}

      <fieldset
        className="space-y-2"
        aria-describedby={purposeErrors.length ? 'purposes-error' : undefined}
      >
        <legend className="text-sm font-medium">{t('purposes')}</legend>
        {purposes.map((purpose) => (
          <label key={purpose.value} className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="allowedPurposes" value={purpose.value} className="mt-1" />
            <span>
              {purpose.label}
              {purpose.description ? (
                <span className="block text-muted-foreground">{purpose.description}</span>
              ) : null}
            </span>
          </label>
        ))}
        {purposeErrors.length ? (
          <p id="purposes-error" className="text-sm text-red-700">
            {purposeErrors.join(' ')}
          </p>
        ) : null}
      </fieldset>

      <ExposedFieldsEditor state={state} />

      <Field name="legalBasisText" label={t('legalBasis')} state={state}>
        {(p) => <textarea {...p} rows={3} className={inputClass} />}
      </Field>
      <Field
        name="legalReferences"
        label={t('legalReferences')}
        hint={t('legalReferencesHint')}
        state={state}
      >
        {(p) => <textarea {...p} rows={3} className={inputClass} />}
      </Field>
      <Button type="submit" disabled={pending}>
        {t('submit')}
      </Button>
    </form>
  );
}

export function ReplaceOpenapiForm({ apiId, versionId }: { apiId: string; versionId: string }) {
  const t = useTranslations('version.detail');
  const [state, action, pending] = useActionState(
    replaceOpenapiAction.bind(null, apiId, versionId),
    initialFormState,
  );
  return (
    <form action={action} className="max-w-2xl space-y-4" noValidate>
      <ErrorSummary state={state} />
      <OpenapiInputs state={state} />
      <Button type="submit" variant="outline" disabled={pending}>
        {t('replaceSubmit')}
      </Button>
    </form>
  );
}

export function SubmitVersionForm({
  apiId,
  versionId,
  disabled,
}: {
  apiId: string;
  versionId: string;
  disabled: boolean;
}) {
  const t = useTranslations('version.detail');
  const [state, action, pending] = useActionState(
    submitVersionAction.bind(null, apiId, versionId),
    initialFormState,
  );
  return (
    <form action={action} className="space-y-3">
      <ErrorSummary state={state} />
      <Button type="submit" disabled={disabled || pending}>
        {t('submit')}
      </Button>
    </form>
  );
}
