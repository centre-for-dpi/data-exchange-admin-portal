import { apiDetailSchema, apiVersionDetailSchema, purposeListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ReplaceOpenapiForm, SubmitVersionForm } from '../../../../../../components/apis/api-forms';
import { VersionSheet } from '../../../../../../components/apis/version-sheet';
import { Notice } from '../../../../../../components/ui/notice';
import { Page, PageHeader, Section } from '../../../../../../components/ui/page';
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
    <Page>
      <PageHeader
        eyebrow={api.name}
        title={t('version.detail.title', { api: api.name, version: version.version })}
      />

      {version.status === 'in_review' ? (
        <Notice tone="warning" role="status">
          {t('version.detail.inReview')}
        </Notice>
      ) : null}
      {version.status === 'published' ? (
        <Notice tone="success" role="status">
          {t('version.detail.published')}
        </Notice>
      ) : null}

      <VersionSheet version={version} purposeNames={purposeNames} />

      {canWrite && editable ? (
        <>
          <Section title={t('version.detail.replace')}>
            <div className="card max-w-3xl p-6 md:p-8">
              <ReplaceOpenapiForm apiId={api.id} versionId={version.id} />
            </div>
          </Section>
          <div className="card flex flex-wrap items-center justify-between gap-4 bg-surface-panel p-6">
            <SubmitVersionForm
              apiId={api.id}
              versionId={version.id}
              disabled={!version.lintReport.valid}
            />
          </div>
        </>
      ) : null}
    </Page>
  );
}
