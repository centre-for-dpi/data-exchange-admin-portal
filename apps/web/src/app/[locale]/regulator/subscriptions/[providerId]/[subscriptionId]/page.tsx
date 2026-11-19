import { subscriptionDetailSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { RegulatorDecisionForms } from '../../../../../../components/regulator/decision-forms';
import { AgreementSection } from '../../../../../../components/subscriptions/agreement-section';
import { SubscriptionFacts } from '../../../../../../components/subscriptions/subscription-view';
import { EmptyState, Page, PageHeader, Section } from '../../../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../../../lib/api';
import { getViewer } from '../../../../../../lib/viewer';
import { uuidParams } from '../../../../../../lib/route-params';

interface PageProps {
  params: Promise<{ locale: string; providerId: string; subscriptionId: string }>;
}

async function load(providerId: string, subscriptionId: string) {
  try {
    return await apiGet(
      `/entities/${providerId}/access-requests/${subscriptionId}`,
      subscriptionDetailSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, providerId, subscriptionId } = uuidParams(
    await params,
    'providerId',
    'subscriptionId',
  );
  const t = await getTranslations({ locale, namespace: 'subscriptions' });
  return { title: t('detailTitle', { api: (await load(providerId, subscriptionId)).api.name }) };
}

/** An access request to sensitive data, as the regulator sees it (M2-04). */
export default async function RegulatorSubscriptionPage({ params }: PageProps) {
  const { locale, providerId, subscriptionId } = uuidParams(
    await params,
    'providerId',
    'subscriptionId',
  );
  setRequestLocale(locale);
  const t = await getTranslations();
  if (!(await getViewer()).platformRoles.includes('regulator')) notFound();
  const detail = await load(providerId, subscriptionId);
  return (
    <Page>
      <PageHeader
        eyebrow={detail.application.entity.shortName}
        title={t('subscriptions.detailTitle', { api: detail.api.name })}
      />
      <SubscriptionFacts detail={detail} side="provider" />
      <AgreementSection
        detail={detail}
        entityId={providerId}
        collection="access-requests"
        canUpload={false}
      />
      <Section title={t('regulator.decision.title')}>
        {detail.status === 'pending_regulator' ? (
          <div className="card p-6 md:p-8">
            <RegulatorDecisionForms target="subscriptions" id={detail.id} />
          </div>
        ) : (
          <EmptyState>{t('regulator.decision.notPending')}</EmptyState>
        )}
      </Section>
    </Page>
  );
}
