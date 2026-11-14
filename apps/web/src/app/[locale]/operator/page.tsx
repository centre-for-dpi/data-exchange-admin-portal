import { entityRequestListSchema, reviewQueueSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Badge, classificationTone, StatusBadge } from '../../../components/ui/badge';
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
  return { title: t('operator') };
}

const REVIEW_ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];

export default async function OperatorPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => REVIEW_ROLES.includes(r))) notFound();

  const [queue, onboarding] = await Promise.all([
    apiGet('/review/api-versions', reviewQueueSchema),
    apiGet('/review/entities', entityRequestListSchema),
  ]);

  return (
    <Page>
      <PageHeader
        title={t('nav.operator')}
        actions={
          <>
            <Link href="/operator/entities" className="link">
              {t('entityAdmin.title')}
            </Link>
            <Link href="/operator/purposes" className="link">
              {t('purposes.title')}
            </Link>
          </>
        }
      />
      <Section title={t('operator.entitiesTitle')}>
        {onboarding.items.length === 0 ? (
          <EmptyState>{t('operator.entitiesEmpty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('operator.entity')}</th>
                  <th scope="col">{t('entityRequests.status')}</th>
                  <th scope="col">{t('operator.submittedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {onboarding.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/entity-requests/${item.id}`} className="link">
                        {item.legalName}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={item.status}>
                        {t(`entityStatus.${item.status}`)}
                      </StatusBadge>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {item.submittedAt
                        ? format.dateTime(new Date(item.submittedAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title={t('operator.queueTitle')}>
        {queue.items.length === 0 ? (
          <EmptyState>{t('operator.empty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('operator.api')}</th>
                  <th scope="col">{t('operator.version')}</th>
                  <th scope="col">{t('operator.entity')}</th>
                  <th scope="col">{t('operator.classification')}</th>
                  <th scope="col">{t('operator.submittedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {queue.items.map((item) => (
                  <tr key={item.versionId}>
                    <td>
                      <Link href={`/operator/reviews/${item.versionId}`} className="link">
                        {item.api.name}
                      </Link>
                    </td>
                    <td className="font-mono">{item.version}</td>
                    <td>{item.entity.shortName}</td>
                    <td>
                      <Badge tone={classificationTone(item.api.classification)}>
                        {t(`classification.${item.api.classification}`)}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {item.submittedAt
                        ? format.dateTime(new Date(item.submittedAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : ''}
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
