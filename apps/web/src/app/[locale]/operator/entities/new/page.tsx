import { getCountryConfig } from '@den/config';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EntityRequestForm } from '../../../../../components/entity-requests/forms';
import { Page, PageHeader } from '../../../../../components/ui/page';
import { localize } from '../../../../../lib/localize';
import { getViewer } from '../../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'entityAdmin.create' });
  return { title: t('title') };
}

/** Operator: direct registration of an entity, without an onboarding request (SPEC.md §4.1). */
export default async function NewNetworkEntityPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('entityAdmin.create');
  if (!(await getViewer()).platformRoles.includes('platform_admin')) notFound();
  const config = getCountryConfig();
  return (
    <Page>
      <PageHeader title={t('title')} description={t('lead')} />
      <div className="card max-w-3xl p-6 md:p-8">
        <EntityRequestForm
          locale={locale}
          direct
          sectors={config.sectors.map((s) => ({ value: s.code, label: localize(s.name, locale) }))}
          taxIdTypes={config.identifiers.organization}
        />
      </div>
    </Page>
  );
}
