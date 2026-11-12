import { subscriptionDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { SubscriptionFacts } from '../../../../../components/subscriptions/subscription-view';
import { AutoRefresh } from '../../../../../components/auto-refresh';
import { ApiError, apiGet } from '../../../../../lib/api';
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
  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-bold">{t('detailTitle', { api: detail.api.name })}</h1>
      {detail.status === 'approved' ? (
        <>
          <p className="text-sm text-muted-foreground">{t('activatingNote')}</p>
          <AutoRefresh />
        </>
      ) : null}
      <SubscriptionFacts detail={detail} side="consumer" />
    </section>
  );
}
