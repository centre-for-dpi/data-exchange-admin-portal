'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef } from 'react';
import { initialFormState } from '../../lib/forms';
import {
  createNodeAction,
  decommissionNodeAction,
  type IssueTokenState,
  reissueTokenAction,
  revokeTokenAction,
} from '../../lib/node-actions';
import { CopyButton } from '../apps/app-forms';
import { ErrorSummary, errorTextClass, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';

/**
 * The enrollment token right after it is issued (M4-01). It is shown here once and never again:
 * whoever installs the kit at the bootcamp pastes it into the installer.
 */
function IssuedToken({ issued }: { issued: NonNullable<IssueTokenState['issued']> }) {
  const t = useTranslations('nodes.token');
  const format = useFormatter();
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    heading.current?.focus();
  }, [issued.token]);
  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <h3 id={headingId} ref={heading} tabIndex={-1} className="text-lg font-semibold">
        {t('title', { name: issued.nodeName })}
      </h3>
      <p
        role="alert"
        className="rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-sm font-medium text-danger-fg"
      >
        {t('warning', {
          date: format.dateTime(new Date(issued.expiresAt), {
            dateStyle: 'long',
            timeStyle: 'short',
          }),
        })}
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface-app py-2 pr-2 pl-4 text-sm">
        <code data-testid="enrollment-token" className="flex-1 break-all">
          {issued.token}
        </code>
        <CopyButton value={issued.token} label={t('label')} />
      </div>
    </section>
  );
}

/** Registers a node and issues its first token (entity_admin or operator). */
export function CreateNodeForm({ entityId }: { entityId: string }) {
  const t = useTranslations('nodes.create');
  const [state, action, pending] = useActionState(
    createNodeAction.bind(null, entityId),
    initialFormState as IssueTokenState,
  );
  return (
    <div className="space-y-6">
      {state.issued ? <IssuedToken issued={state.issued} /> : null}
      <form action={action} className="space-y-5" noValidate>
        <ErrorSummary state={state} />
        <Field name="name" label={t('name')} hint={t('nameHint')} required state={state}>
          {(p) => (
            <input
              {...p}
              type="text"
              autoComplete="off"
              maxLength={80}
              defaultValue={state.values?.name ?? ''}
              className={inputClass}
            />
          )}
        </Field>
        <Button type="submit" disabled={pending}>
          {t('submit')}
        </Button>
      </form>
    </div>
  );
}

/** A new token for a node that has not enrolled (the previous one is revoked). */
export function ReissueTokenForm({
  entityId,
  nodeId,
  nodeName,
}: {
  entityId: string;
  nodeId: string;
  nodeName: string;
}) {
  const t = useTranslations('nodes');
  const [state, action, pending] = useActionState(
    reissueTokenAction.bind(null, entityId, nodeId),
    initialFormState as IssueTokenState,
  );
  return (
    <div className="space-y-3">
      {state.issued ? <IssuedToken issued={state.issued} /> : null}
      <form action={action}>
        {state.formError ? <p className={errorTextClass}>{state.formError}</p> : null}
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-label={t('reissueFor', { name: nodeName })}
        >
          {t('reissue')}
        </Button>
      </form>
    </div>
  );
}

export function RevokeTokenButton({
  entityId,
  nodeId,
  tokenId,
  nodeName,
}: {
  entityId: string;
  nodeId: string;
  tokenId: string;
  nodeName: string;
}) {
  const t = useTranslations('nodes');
  const [state, action, pending] = useActionState(
    revokeTokenAction.bind(null, entityId, nodeId, tokenId),
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
        aria-label={t('revokeFor', { name: nodeName })}
      >
        {t('revoke')}
      </Button>
    </form>
  );
}

/** Takes a node out of the network for good (M4-02). */
export function DecommissionNodeButton({
  entityId,
  nodeId,
  nodeName,
}: {
  entityId: string;
  nodeId: string;
  nodeName: string;
}) {
  const t = useTranslations('nodes');
  const [state, action, pending] = useActionState(
    decommissionNodeAction.bind(null, entityId, nodeId),
    initialFormState,
  );
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(t('decommissionConfirm', { name: nodeName }))) event.preventDefault();
      }}
    >
      {state.formError ? <p className={errorTextClass}>{state.formError}</p> : null}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={t('decommissionFor', { name: nodeName })}
      >
        {t('decommission')}
      </Button>
    </form>
  );
}
