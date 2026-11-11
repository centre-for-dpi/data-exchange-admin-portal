import { apiDetailSchema, purposeListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CreateVersionForm } from '../../../../../../components/apis/api-forms';
import { ApiError, apiGet } from '../../../../../../lib/api';
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

  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-2xl font-bold">{t('version.create.title', { api: api.name })}</h1>
      <div className="mt-6">
        <CreateVersionForm apiId={api.id} purposes={purposes} />
      </div>
    </section>
  );
}
