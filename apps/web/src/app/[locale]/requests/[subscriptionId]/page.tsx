import { subscriptionDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { RequestDecisionForms } from '../../../../components/subscriptions/subscription-forms';
import { SubscriptionFacts } from '../../../../components/subscriptions/subscription-view';
import { ApiError, apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; subscriptionId: string }>;
}

async function load(subscriptionId: string) {
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  try {
    const detail = await apiGet(
      `/entities/${entity.entity.id}/access-requests/${subscriptionId}`,
      subscriptionDetailSchema,
    );
    return { detail, entity };
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, subscriptionId } = await params;
  const t = await getTranslations({ locale, namespace: 'subscriptions' });
  return { title: t('detailTitle', { api: (await load(subscriptionId)).detail.api.name }) };
}

/** Provider view of an access request, with the data steward's decision forms. */
export default async function AccessRequestPage({ params }: PageProps) {
  const { locale, subscriptionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('subscriptions');
  const { detail, entity } = await load(subscriptionId);
  const pending = detail.status === 'pending_provider';
  // The API enforces separation of duties; the UI only avoids offering a doomed action. A user who
  // also develops for the requesting entity may be the requester, so the forms stay and the API
  // answers 403 with the reason.
  const canDecide = pending && entity.roles.includes('data_steward');

  return (
    <section className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <h1 className="text-2xl font-bold">{t('detailTitle', { api: detail.api.name })}</h1>
      <SubscriptionFacts detail={detail} side="provider" />
      {canDecide ? (
        <div className="space-y-4">
          {detail.requiresRegulator ? (
            <p className="rounded-md border border-border p-3 text-sm">{t('regulatorNote')}</p>
          ) : null}
          <RequestDecisionForms
            subscriptionId={detail.id}
            operations={detail.operations}
            requested={detail.effectiveRequestedOperations}
            requestedMonths={detail.requestedValidityMonths}
            rateLimit={detail.requestedRateLimit}
          />
        </div>
      ) : null}
      {detail.status === 'approved' ? (
        <p className="text-sm text-muted-foreground">{t('activatingNote')}</p>
      ) : null}
    </section>
  );
}
