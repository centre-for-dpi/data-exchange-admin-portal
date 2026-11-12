import { getTranslations } from 'next-intl/server';
import { EmptyState, Page, PageHeader } from './ui/page';

/** Placeholder for sections delivered by later backlog stories. */
export async function ComingSoon({ navKey }: { navKey: string }) {
  const t = await getTranslations();
  return (
    <Page>
      <PageHeader title={t(`nav.${navKey}`)} />
      <EmptyState>{t('comingSoon.body')}</EmptyState>
    </Page>
  );
}
