import { subscriptionPageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { SubscriptionTable } from '../../../components/subscriptions/subscription-view';
import { EmptyState, Page, PageHeader } from '../../../components/ui/page';
import { Link } from '../../../i18n/navigation';
import { ApiError, apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'subscriptions.inbox' });
  return { title: t('title') };
}

/** Provider inbox: requests other entities made to the active entity's APIs (SPEC.md §6). */
export default async function RequestsInboxPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('subscriptions.inbox');
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  const all = (await searchParams).view === 'all';
  const query = all ? 'limit=100' : 'status=pending_provider&limit=100';
  let page;
  try {
    page = await apiGet(
      `/entities/${entity.entity.id}/access-requests?${query}`,
      subscriptionPageSchema,
    );
  } catch (error) {
    // Members without a provider role (e.g. only app developers) have no inbox.
    if (error instanceof ApiError && error.status === 403) notFound();
    throw error;
  }
  const canDecide = entity.roles.includes('data_steward');

  const tab = (active: boolean) =>
    active
      ? 'block rounded-full bg-background px-4 py-1.5 font-medium text-foreground-strong shadow-sm'
      : 'block rounded-full px-4 py-1.5 text-muted-foreground hover:text-foreground-strong';

  return (
    <Page>
      <PageHeader
        eyebrow={entity.entity.shortName}
        title={t('title')}
        description={!canDecide ? t('readOnly') : undefined}
      />
      <nav aria-label={t('title')}>
        <ul className="inline-flex gap-1 rounded-full border border-border bg-surface-app p-1 text-sm">
          <li>
            <Link href="/requests" aria-current={all ? undefined : 'page'} className={tab(!all)}>
              {t('pending')}
            </Link>
          </li>
          <li>
            <Link
              href="/requests?view=all"
              aria-current={all ? 'page' : undefined}
              className={tab(all)}
            >
              {t('all')}
            </Link>
          </li>
        </ul>
      </nav>
      {page.items.length === 0 ? (
        <EmptyState>{t('empty')}</EmptyState>
      ) : (
        <SubscriptionTable items={page.items} side="provider" hrefBase="/requests" />
      )}
    </Page>
  );
}
