import { apiPageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Badge, StatusBadge, classificationTone } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { EmptyState, Page, PageHeader } from '../../../components/ui/page';
import { Link } from '../../../i18n/navigation';
import { apiGetAll } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('myApis') };
}

export default async function MyApisPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const viewer = await getViewer();
  const entity = viewer.activeEntity;

  if (!entity) {
    return (
      <Page>
        <PageHeader title={t('nav.myApis')} />
        <EmptyState>{t('myApis.noEntity')}</EmptyState>
      </Page>
    );
  }

  const canWrite = entity.roles.includes('api_publisher');
  const page = await apiGetAll(`/entities/${entity.entity.id}/apis`, apiPageSchema);
  const newApi = canWrite ? (
    <Button asChild>
      <Link href="/my-apis/new">{t('myApis.newApi')}</Link>
    </Button>
  ) : null;

  return (
    <Page>
      <PageHeader
        eyebrow={entity.entity.shortName}
        title={t('nav.myApis')}
        description={!canWrite ? t('myApis.readOnly') : undefined}
        actions={newApi}
      />

      {page.items.length === 0 ? (
        <EmptyState>{t('myApis.empty')}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('myApis.name')}</th>
                <th scope="col">{t('myApis.classification')}</th>
                <th scope="col">{t('myApis.status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((api) => (
                <tr key={api.id}>
                  <td>
                    <Link href={`/my-apis/${api.id}`} className="link">
                      {api.name}
                    </Link>
                  </td>
                  <td>
                    <Badge tone={classificationTone(api.classification)}>
                      {t(`classification.${api.classification}`)}
                    </Badge>
                  </td>
                  <td>
                    <StatusBadge status={api.status}>{t(`apiStatus.${api.status}`)}</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
