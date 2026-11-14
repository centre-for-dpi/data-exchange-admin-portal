import { getCountryConfig } from '@rid/config';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EntityRequestForm } from '../../../../components/entity-requests/forms';
import { Page, PageHeader } from '../../../../components/ui/page';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'entityRequests' });
  return { title: t('new') };
}

export default async function NewEntityRequestPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('entityRequests');
  if (!(await getViewer()).authenticated) notFound();
  const config = getCountryConfig();
  return (
    <Page>
      <PageHeader
        title={t('new')}
        description={t('newLead', { operator: config.authorities.operator.shortName })}
      />
      <div className="card max-w-3xl p-6 md:p-8">
        <EntityRequestForm
          locale={locale}
          sectors={config.sectors.map((s) => ({ value: s.code, label: localize(s.name, locale) }))}
          taxIdTypes={config.identifiers.organization}
        />
      </div>
    </Page>
  );
}
