import { apiDetailSchema, apiVersionDetailSchema, purposeListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ReplaceOpenapiForm, SubmitVersionForm } from '../../../../../../components/apis/api-forms';
import { VersionSheet } from '../../../../../../components/apis/version-sheet';
import { ApiError, apiGet } from '../../../../../../lib/api';
import { localize } from '../../../../../../lib/localize';
import { getViewer } from '../../../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; apiId: string; versionId: string }>;
}

async function load(apiId: string, versionId: string) {
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  const base = `/entities/${entity.entity.id}/apis/${apiId}`;
  try {
    const [api, version] = await Promise.all([
      apiGet(base, apiDetailSchema),
      apiGet(`${base}/versions/${versionId}`, apiVersionDetailSchema),
    ]);
    return { entity, api, version };
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, apiId, versionId } = await params;
  const { api, version } = await load(apiId, versionId);
  const t = await getTranslations({ locale, namespace: 'version.detail' });
  return { title: t('title', { api: api.name, version: version.version }) };
}

export default async function VersionPage({ params }: PageProps) {
  const { locale, apiId, versionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const { entity, api, version } = await load(apiId, versionId);
  const purposeNames = new Map(
    (await apiGet('/purposes', purposeListSchema)).items.map((p) => [
      p.code,
      localize(p.name, locale),
    ]),
  );
  const canWrite = entity.roles.includes('api_publisher');
  const editable = version.status === 'draft' || version.status === 'changes_requested';

  return (
    <section className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <h1 className="text-2xl font-bold">
        {t('version.detail.title', { api: api.name, version: version.version })}
      </h1>

      <VersionSheet version={version} purposeNames={purposeNames} />

      {version.status === 'in_review' ? <p role="status">{t('version.detail.inReview')}</p> : null}
      {version.status === 'published' ? <p role="status">{t('version.detail.published')}</p> : null}

      {canWrite && editable ? (
        <>
          <div className="space-y-3">
            <h2 className="text-xl font-semibold">{t('version.detail.replace')}</h2>
            <ReplaceOpenapiForm apiId={api.id} versionId={version.id} />
          </div>
          <SubmitVersionForm
            apiId={api.id}
            versionId={version.id}
            disabled={!version.lintReport.valid}
          />
        </>
      ) : null}
    </section>
  );
}
