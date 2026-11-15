'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { issueCertificateAction } from '../../lib/application-actions';
import { ErrorSummary, Field, inputClass } from '../form/field';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';

/**
 * Asks the network CA for a client certificate (M3-01): the developer pastes the CSR made on
 * their own server, where the private key stays. After signing, the page shows the certificate
 * in the credentials list; this component keeps the confirmation and the download link.
 */
export function CertificateRequestForm({
  applicationId,
  downloadBase,
}: {
  applicationId: string;
  /** Path of the download route, without the credential id. */
  downloadBase: string;
}) {
  const t = useTranslations('myApps.certificates');
  const [state, action, pending] = useActionState(issueCertificateAction, {});
  const done = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.issued) done.current?.focus();
  }, [state.issued]);

  if (state.issued) {
    return (
      <Notice tone="success" role="status" ref={done} tabIndex={-1} className="space-y-3">
        <p>{t('issued')}</p>
        <Button asChild variant="outline" size="sm">
          <a href={`${downloadBase}/${state.issued.credentialId}/certificate`} download>
            {t('download')}
          </a>
        </Button>
      </Notice>
    );
  }

  return (
    <form action={action} className="space-y-5" noValidate>
      <ErrorSummary state={state} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <Field name="csr" label={t('csr')} hint={t('csrHint')} required state={state}>
        {(p) => (
          <textarea
            {...p}
            rows={8}
            spellCheck={false}
            autoComplete="off"
            defaultValue={state.values?.csr}
            className={`${inputClass} font-mono text-xs`}
          />
        )}
      </Field>
      <Button type="submit" disabled={pending}>
        {t('submit')}
      </Button>
    </form>
  );
}
