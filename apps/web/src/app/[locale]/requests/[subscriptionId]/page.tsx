import { subscriptionDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  RequestDecisionForms,
  RevokeForm,
} from '../../../../components/subscriptions/subscription-forms';
import { SubscriptionFacts } from '../../../../components/subscriptions/subscription-view';
import { AutoRefresh } from '../../../../components/auto-refresh';
import { AuditTimeline } from '../../../../components/audit/audit-views';
import { Notice } from '../../../../components/ui/notice';
import { Page, PageHeader, Section } from '../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../lib/api';
import { entityTimeline } from '../../../../lib/audit';
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
  const timeline = await entityTimeline(entity.entity.id, 'subscription', detail.id);
  const pending = detail.status === 'pending_provider';
  // The API enforces separation of duties; the UI only avoids offering a doomed action. A user who
  // also develops for the requesting entity may be the requester, so the forms stay and the API
  // answers 403 with the reason.
  const steward = entity.roles.includes('data_steward');
  const canDecide = pending && steward;
  const canRevoke = steward && ['approved', 'active', 'suspended'].includes(detail.status);

  return (
    <Page>
      <PageHeader
        eyebrow={detail.application.entity.shortName}
        title={t('detailTitle', { api: detail.api.name })}
      />
      {detail.status === 'approved' ? (
        <>
          <Notice tone="info">{t('activatingNote')}</Notice>
          <AutoRefresh />
        </>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SubscriptionFacts detail={detail} side="provider" />
        <AuditTimeline items={timeline} />
      </div>
      {canDecide ? (
        <div className="space-y-4">
          {detail.requiresRegulator ? <Notice tone="warning">{t('regulatorNote')}</Notice> : null}
          <div className="card p-6 md:p-8">
            <RequestDecisionForms
              subscriptionId={detail.id}
              operations={detail.operations}
              requested={detail.effectiveRequestedOperations}
              requestedMonths={detail.requestedValidityMonths}
              rateLimit={detail.requestedRateLimit}
            />
          </div>
        </div>
      ) : null}
      {canRevoke ? (
        <Section title={t('decide.revoke')}>
          <div className="card max-w-3xl border-danger-border/40 p-6 md:p-8">
            <RevokeForm subscriptionId={detail.id} />
          </div>
        </Section>
      ) : null}
    </Page>
  );
}
