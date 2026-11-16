import { regulatorQueueSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Badge, classificationTone } from '../../../components/ui/badge';
import { EmptyState, Page, PageHeader, Section } from '../../../components/ui/page';
import { Link } from '../../../i18n/navigation';
import { apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('regulator') };
}

/** The regulator's view (SPEC.md §6): approvals that belong to it (M2-04). */
export default async function RegulatorPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  if (!(await getViewer()).platformRoles.includes('regulator')) notFound();
  const queue = await apiGet('/regulator/approvals', regulatorQueueSchema);
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '';

  return (
    <Page>
      <PageHeader
        title={t('nav.regulator')}
        description={t('regulator.lead')}
        actions={
          <Link href="/regulator/indicators" className="link">
            {t('indicators.title')}
          </Link>
        }
      />
      <Section title={t('regulator.versionsTitle')}>
        {queue.apiVersions.length === 0 ? (
          <EmptyState>{t('regulator.versionsEmpty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('operator.api')}</th>
                  <th scope="col">{t('operator.version')}</th>
                  <th scope="col">{t('operator.entity')}</th>
                  <th scope="col">{t('operator.classification')}</th>
                  <th scope="col">{t('regulator.operatorApprovedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {queue.apiVersions.map((v) => (
                  <tr key={v.versionId}>
                    <td>
                      <Link href={`/operator/reviews/${v.versionId}`} className="link">
                        {v.api.name}
                      </Link>
                    </td>
                    <td className="font-mono">{v.version}</td>
                    <td>{v.entity.shortName}</td>
                    <td>
                      <Badge tone={classificationTone(v.api.classification)}>
                        {t(`classification.${v.api.classification}`)}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {when(v.operatorApprovedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title={t('regulator.subscriptionsTitle')}>
        {queue.subscriptions.length === 0 ? (
          <EmptyState>{t('regulator.subscriptionsEmpty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('operator.api')}</th>
                  <th scope="col">{t('regulator.provider')}</th>
                  <th scope="col">{t('regulator.consumer')}</th>
                  <th scope="col">{t('regulator.requestedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {queue.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link
                        href={`/regulator/subscriptions/${s.provider.id}/${s.id}`}
                        className="link"
                      >
                        {s.api.name} {s.version.version}
                      </Link>
                    </td>
                    <td>{s.provider.shortName}</td>
                    <td>{s.consumer.shortName}</td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {when(s.requestedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}
