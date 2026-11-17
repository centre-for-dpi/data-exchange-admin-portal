import { apiDetailSchema, nodeListSchema, purposeListSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CreateVersionForm } from '../../../../../../components/apis/api-forms';
import { ApiError, apiGet } from '../../../../../../lib/api';
import { Page, PageHeader } from '../../../../../../components/ui/page';
import { localize } from '../../../../../../lib/localize';
import { getViewer } from '../../../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; apiId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'myApis.detail' });
  return { title: t('newVersion') };
}

export default async function NewVersionPage({ params }: PageProps) {
  const { locale, apiId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const entity = (await getViewer()).activeEntity;
  if (!entity?.roles.includes('api_publisher')) notFound();

  let api;
  try {
    api = await apiGet(`/entities/${entity.entity.id}/apis/${apiId}`, apiDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
  const purposes = (await apiGet('/purposes', purposeListSchema)).items.map((p) => ({
    value: p.code,
    label: localize(p.name, locale),
    description: localize(p.description, locale),
  }));

  // Nodes of the kit still in the network (M4-04), newest first.
  const nodes = (await apiGet(`/entities/${entity.entity.id}/nodes`, nodeListSchema)).items
    .filter((n) => n.status !== 'decommissioned')
    .map((n) => ({
      value: n.id,
      label: `${n.name} (${t(`nodeStatus.${n.status}`)})`,
      description: '',
    }));

  return (
    <Page>
      <PageHeader title={t('version.create.title', { api: api.name })} />
      <div className="card max-w-3xl p-6 md:p-8">
        <CreateVersionForm apiId={api.id} purposes={purposes} nodes={nodes} />
      </div>
    </Page>
  );
}
