import { apiDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Button } from '../../../../components/ui/button';
import { Link } from '../../../../i18n/navigation';
import { AuditTimeline } from '../../../../components/audit/audit-views';
import { ApiError, apiGet } from '../../../../lib/api';
import { entityTimeline } from '../../../../lib/audit';
import { getViewer } from '../../../../lib/viewer';

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
  const { apiId } = await params;
  const { api } = await loadApi(apiId);
  return { title: api.name };
}

export default async function ApiPage({ params }: PageProps) {
  const { locale, apiId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const { entity, api } = await loadApi(apiId);
  const canWrite = entity.roles.includes('api_publisher');
  const timeline = await entityTimeline(entity.entity.id, 'api', api.id);

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-bold">{api.name}</h1>
        <p className="mt-2 text-muted-foreground">{api.summary}</p>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{t('myApis.classification')}</dt>
        <dd>{t(`classification.${api.classification}`)}</dd>
        <dt className="font-medium">{t('myApis.status')}</dt>
        <dd>{t(`apiStatus.${api.status}`)}</dd>
        <dt className="font-medium">{t('myApis.detail.owner')}</dt>
        <dd>{api.ownerContact}</dd>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">{t('myApis.detail.versions')}</h2>
        {canWrite ? (
          <Button asChild variant="outline">
            <Link href={`/my-apis/${api.id}/versions/new`}>{t('myApis.detail.newVersion')}</Link>
          </Button>
        ) : null}
      </div>
      {api.versions.length === 0 ? (
        <p>{t('myApis.detail.noVersions')}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2">
                {t('myApis.detail.version')}
              </th>
              <th scope="col" className="py-2">
                {t('myApis.detail.basePath')}
              </th>
              <th scope="col" className="py-2">
                {t('myApis.status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {api.versions.map((v) => (
              <tr key={v.id} className="border-b border-border">
                <td className="py-2">
                  <Link href={`/my-apis/${api.id}/versions/${v.id}`} className="underline">
                    {v.version}
                  </Link>
                </td>
                <td className="py-2 font-mono">{v.basePath}</td>
                <td className="py-2">{t(`versionStatus.${v.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AuditTimeline items={timeline} />
    </section>
  );
}
