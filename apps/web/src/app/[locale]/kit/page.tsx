import { currentKitReleaseSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { KitReleasePanel } from '../../../components/kit/kit-release';
import { Page, PageHeader, Section } from '../../../components/ui/page';
import { apiGet } from '../../../lib/api';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'kit' });
  return { title: t('title') };
}

/**
 * The node kit on the public site (P-03): for entities that are not part of the network yet, the
 * version the operator offers, its checksum and how to install it. No session needed.
 */
export default async function KitPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('kit');
  const kit = await apiGet('/kit/current', currentKitReleaseSchema, { anonymous: true });

  return (
    <Page>
      <PageHeader title={t('title')} description={t('publicLead')} />
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{t('publicToken')}</p>
      <Section id="kit-release" title={t('sectionTitle')}>
        <KitReleasePanel release={kit.release} locale={locale} />
      </Section>
    </Page>
  );
}
