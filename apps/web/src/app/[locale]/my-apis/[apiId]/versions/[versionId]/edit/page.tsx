import {
  apiDetailSchema,
  apiVersionDetailSchema,
  nodeListSchema,
  purposeListSchema,
  upstreamTypesSchema,
} from '@den/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EditVersionForm } from '../../../../../../../components/apis/api-forms';
import { Page, PageHeader } from '../../../../../../../components/ui/page';
import { Link } from '../../../../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../../../../lib/api';
import { localize } from '../../../../../../../lib/localize';
import { uuidParams } from '../../../../../../../lib/route-params';
import { getViewer } from '../../../../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; apiId: string; versionId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'version.detail' });
  return { title: t('edit') };
}

/**
 * Edits what a version in draft or with changes requested declares (R-07). Only the publishers of
 * the entity; the API checks it again and answers 409 to any other state.
 */
export default async function EditVersionPage({ params }: PageProps) {
  const { locale, apiId, versionId } = uuidParams(await params, 'apiId', 'versionId');
  setRequestLocale(locale);
  const t = await getTranslations();
  const entity = (await getViewer()).activeEntity;
  if (!entity?.roles.includes('api_publisher')) notFound();

  const base = `/entities/${entity.entity.id}/apis/${apiId}`;
  let api;
  let version;
  try {
    [api, version] = await Promise.all([
      apiGet(base, apiDetailSchema),
      apiGet(`${base}/versions/${versionId}`, apiVersionDetailSchema),
    ]);
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
  if (version.status !== 'draft' && version.status !== 'changes_requested') notFound();

  const purposes = (await apiGet('/purposes', purposeListSchema)).items.map((p) => ({
    value: p.code,
    label: localize(p.name, locale),
    description: localize(p.description, locale),
  }));
  const nodes = (await apiGet(`/entities/${entity.entity.id}/nodes`, nodeListSchema)).items
    .filter((n) => n.status !== 'decommissioned')
    .map((n) => ({
      value: n.id,
      label: `${n.name} (${t(`nodeStatus.${n.status}`)})`,
      description: '',
    }));
  const { allowed } = await apiGet('/upstream-types', upstreamTypesSchema);

  return (
    <Page>
      <PageHeader
        eyebrow={api.name}
        title={t('version.detail.editTitle', { api: api.name, version: version.version })}
        description={t('version.detail.editHint')}
      />
      <Link
        href={`/my-apis/${api.id}/versions/${version.id}`}
        className="link inline-block text-sm"
      >
        <span aria-hidden="true">← </span>
        {t('version.detail.title', { api: api.name, version: version.version })}
      </Link>
      <div className="card max-w-3xl p-6 md:p-8">
        <EditVersionForm
          apiId={api.id}
          version={version}
          purposes={purposes}
          nodes={nodes}
          upstreamTypes={allowed}
        />
      </div>
    </Page>
  );
}
