import { apiDetailSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Badge, StatusBadge, classificationTone } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card, EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { AuditTimeline } from '../../../../components/audit/audit-views';
import { ApiError, apiGet } from '../../../../lib/api';
import { entityTimeline } from '../../../../lib/audit';
import { getViewer } from '../../../../lib/viewer';
import { uuidParams } from '../../../../lib/route-params';

interface PageProps {
  params: Promise<{ locale: string; apiId: string }>;
}

async function loadApi(apiId: string) {
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  try {
    return {
      entity,
      api: await apiGet(`/entities/${entity.entity.id}/apis/${apiId}`, apiDetailSchema),
    };
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { apiId } = uuidParams(await params, 'apiId');
  const { api } = await loadApi(apiId);
  return { title: api.name };
}

export default async function ApiPage({ params }: PageProps) {
  const { locale, apiId } = uuidParams(await params, 'apiId');
  setRequestLocale(locale);
  const t = await getTranslations();
  const { entity, api } = await loadApi(apiId);
  const canWrite = entity.roles.includes('api_publisher');
  const timeline = await entityTimeline(entity.entity.id, 'api', api.id);

  return (
    <Page>
      <PageHeader eyebrow={entity.entity.shortName} title={api.name} description={api.summary} />
      <Card>
        <dl className="facts">
          <dt>{t('myApis.classification')}</dt>
          <dd>
            <Badge tone={classificationTone(api.classification)}>
              {t(`classification.${api.classification}`)}
            </Badge>
          </dd>
          <dt>{t('myApis.status')}</dt>
          <dd>
            <StatusBadge status={api.status}>{t(`apiStatus.${api.status}`)}</StatusBadge>
          </dd>
          <dt>{t('myApis.detail.owner')}</dt>
          <dd>{api.ownerContact}</dd>
        </dl>
      </Card>

      <Section
        title={t('myApis.detail.versions')}
        actions={
          canWrite ? (
            <Button asChild variant="outline">
              <Link href={`/my-apis/${api.id}/versions/new`}>{t('myApis.detail.newVersion')}</Link>
            </Button>
          ) : null
        }
      >
        {api.versions.length === 0 ? (
          <EmptyState>{t('myApis.detail.noVersions')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('myApis.detail.version')}</th>
                  <th scope="col">{t('myApis.detail.basePath')}</th>
                  <th scope="col">{t('myApis.status')}</th>
                </tr>
              </thead>
              <tbody>
                {api.versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link href={`/my-apis/${api.id}/versions/${v.id}`} className="link">
                        {v.version}
                      </Link>
                    </td>
                    <td className="font-mono">{v.basePath}</td>
                    <td>
                      <StatusBadge status={v.status}>{t(`versionStatus.${v.status}`)}</StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <AuditTimeline items={timeline} />
    </Page>
  );
}
