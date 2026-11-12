import { getCountryConfig } from '@rid/config';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CreateApiForm } from '../../../../components/apis/api-forms';
import { EmptyState, Page, PageHeader } from '../../../../components/ui/page';
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
    <Page>
      <PageHeader title={t('myApis.create.title')} />
      {viewer.activeEntity?.roles.includes('api_publisher') ? (
        <div className="card max-w-3xl p-6 md:p-8">
          <CreateApiForm sectors={sectors} />
        </div>
      ) : (
        <EmptyState>{t('myApis.readOnly')}</EmptyState>
      )}
    </Page>
  );
}
