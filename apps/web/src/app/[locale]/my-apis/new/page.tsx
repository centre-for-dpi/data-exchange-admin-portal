import { getCountryConfig } from '@rid/config';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CreateApiForm } from '../../../../components/apis/api-forms';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'myApis.create' });
  return { title: t('title') };
}

export default async function NewApiPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const viewer = await getViewer();
  const sectors = getCountryConfig().sectors.map((s) => ({
    value: s.code,
    label: localize(s.name, locale),
  }));

  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-2xl font-bold">{t('myApis.create.title')}</h1>
      {viewer.activeEntity?.roles.includes('api_publisher') ? (
        <div className="mt-6">
          <CreateApiForm sectors={sectors} />
        </div>
      ) : (
        <p className="mt-3">{t('myApis.readOnly')}</p>
      )}
    </section>
  );
}
