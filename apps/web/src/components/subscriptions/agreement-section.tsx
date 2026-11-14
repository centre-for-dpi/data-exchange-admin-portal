import { getCountryConfig } from '@rid/config';
import type { SubscriptionDetail } from '@rid/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Section } from '../ui/page';
import { AgreementUploadForm } from './subscription-forms';

/**
 * The exchange agreement of an access request (M2-07): download link with its SHA-256 for both
 * sides, the model template of the country config, and the upload form for the requester while
 * the provider has not decided.
 */
export async function AgreementSection({
  detail,
  entityId,
  collection,
  canUpload,
}: {
  detail: SubscriptionDetail;
  /** Entity in whose name the viewer acts (consumer or provider side). */
  entityId: string;
  collection: 'subscriptions' | 'access-requests';
  canUpload: boolean;
}) {
  const t = await getTranslations('subscriptions.agreement');
  const format = await getFormatter();
  const doc = detail.agreementDocument;
  const hasTemplate = Boolean(getCountryConfig().documents.agreementTemplate);
  return (
    <Section title={t('title')} description={t('lead')}>
      <div className="card max-w-3xl space-y-5 p-6 md:p-8">
        {doc ? (
          <dl className="facts">
            <dt>{t('file')}</dt>
            <dd>
              <a
                href={`/files/entities/${entityId}/${collection}/${detail.id}/agreement`}
                className="link"
                download
              >
                {doc.fileName}
              </a>{' '}
              <span className="text-muted-foreground">
                ({format.number(doc.size / 1024, { maximumFractionDigits: 0 })} KB ·{' '}
                {format.dateTime(new Date(doc.uploadedAt), { dateStyle: 'medium' })})
              </span>
            </dd>
            <dt>{t('sha256')}</dt>
            <dd className="font-mono text-xs break-all">{doc.sha256}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        )}
        {hasTemplate ? (
          <p className="text-sm">
            <a href="/files/agreement-template" className="link" download>
              {t('template')}
            </a>
          </p>
        ) : null}
        {canUpload ? (
          <AgreementUploadForm subscriptionId={detail.id} hasAgreement={Boolean(doc)} />
        ) : null}
      </div>
    </Section>
  );
}
