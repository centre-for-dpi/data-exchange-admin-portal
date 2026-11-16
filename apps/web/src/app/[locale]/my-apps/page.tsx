import { applicationPageSchema, subscriptionPageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SubscriptionTable } from '../../../components/subscriptions/subscription-view';
import { Badge, StatusBadge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { EmptyState, Page, PageHeader, Section } from '../../../components/ui/page';
import { Link } from '../../../i18n/navigation';
import { apiGetAll } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('myApps') };
}

export default async function MyAppsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const entity = (await getViewer()).activeEntity;

  if (!entity) {
    return (
      <Page>
        <PageHeader title={t('nav.myApps')} />
        <EmptyState>{t('myApps.noEntity')}</EmptyState>
      </Page>
    );
  }
  const canWrite = entity.roles.includes('app_developer');
  const [page, requests] = await Promise.all([
    apiGetAll(`/entities/${entity.entity.id}/applications`, applicationPageSchema),
    apiGetAll(`/entities/${entity.entity.id}/subscriptions`, subscriptionPageSchema),
  ]);

  return (
    <Page>
      <PageHeader
        eyebrow={entity.entity.shortName}
        title={t('nav.myApps')}
        description={!canWrite ? t('myApps.readOnly') : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/my-apps/usage" className="link">
              {t('usage.consumed.link')}
            </Link>
            {canWrite && (
              <Button asChild>
                <Link href="/my-apps/new">{t('myApps.newApp')}</Link>
              </Button>
            )}
          </div>
        }
      />
      {page.items.length === 0 ? (
        <EmptyState>{t('myApps.empty')}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('myApps.name')}</th>
                <th scope="col">{t('myApps.environment')}</th>
                <th scope="col">{t('myApps.status')}</th>
                <th scope="col">{t('myApps.provisioning')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((app) => (
                <tr key={app.id}>
                  <td>
                    <Link href={`/my-apps/${app.id}`} className="link">
                      {app.name}
                    </Link>
                  </td>
                  <td>
                    <Badge tone={app.environment === 'production' ? 'brand' : 'neutral'}>
                      {t(`myApps.environments.${app.environment}`)}
                    </Badge>
                  </td>
                  <td>
                    <StatusBadge status={app.status}>
                      {t(`myApps.appStatus.${app.status}`)}
                    </StatusBadge>
                  </td>
                  <td>
                    <StatusBadge status={app.provisioning}>
                      {t(`myApps.provisioningStatus.${app.provisioning}`)}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Section title={t('subscriptions.myRequests')} className="pt-4">
        {requests.items.length === 0 ? (
          <EmptyState>{t('subscriptions.noRequests')}</EmptyState>
        ) : (
          <SubscriptionTable items={requests.items} side="consumer" hrefBase="/my-apps/requests" />
        )}
      </Section>
    </Page>
  );
}
