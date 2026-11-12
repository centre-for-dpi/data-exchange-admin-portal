import { subscriptionDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { SubscriptionFacts } from '../../../../../components/subscriptions/subscription-view';
import { AutoRefresh } from '../../../../../components/auto-refresh';
import { AuditTimeline } from '../../../../../components/audit/audit-views';
import { Notice } from '../../../../../components/ui/notice';
import { Page, PageHeader } from '../../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../../lib/api';
import { entityTimeline } from '../../../../../lib/audit';
import { getViewer } from '../../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; subscriptionId: string }>;
}

async function load(subscriptionId: string) {
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  try {
    return await apiGet(
      `/entities/${entity.entity.id}/subscriptions/${subscriptionId}`,
      subscriptionDetailSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, subscriptionId } = await params;
  const t = await getTranslations({ locale, namespace: 'subscriptions' });
  return { title: t('detailTitle', { api: (await load(subscriptionId)).api.name }) };
}

/** Consumer view of one of the entity's access requests. */
export default async function ConsumerSubscriptionPage({ params }: PageProps) {
  const { locale, subscriptionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('subscriptions');
  const detail = await load(subscriptionId);
  const timeline = await entityTimeline(detail.application.entity.id, 'subscription', detail.id);
  return (
    <Page>
      <PageHeader
        eyebrow={detail.application.name}
        title={t('detailTitle', { api: detail.api.name })}
      />
      {detail.status === 'approved' ? (
        <>
          <Notice tone="info">{t('activatingNote')}</Notice>
          <AutoRefresh />
        </>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SubscriptionFacts detail={detail} side="consumer" />
        <AuditTimeline items={timeline} />
      </div>
    </Page>
  );
}
