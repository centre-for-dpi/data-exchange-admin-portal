import { subscriptionDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { LifecycleForm } from '../../../../../components/subscriptions/subscription-forms';
import { SubscriptionFacts } from '../../../../../components/subscriptions/subscription-view';
import { AutoRefresh } from '../../../../../components/auto-refresh';
import { AuditTimeline } from '../../../../../components/audit/audit-views';
import { Notice } from '../../../../../components/ui/notice';
import { buttonVariants } from '../../../../../components/ui/button';
import { Page, PageHeader, Section } from '../../../../../components/ui/page';
import { Link } from '../../../../../i18n/navigation';
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
  const developer = (await getViewer()).activeEntity?.roles.includes('app_developer') ?? false;
  const question = [...detail.decisions].reverse().find((d) => d.decision === 'info_requested');
  const pending = ['pending_provider', 'info_requested', 'pending_regulator'].includes(
    detail.status,
  );
  const renewHref = `/my-apps/request?api=${detail.api.id}&version=${detail.version.id}&renew=${detail.id}`;
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
      {detail.renewal ? (
        <Notice tone="info">
          {t('lifecycle.renewalInProgress')}{' '}
          <Link href={`/my-apps/requests/${detail.renewal.id}`} className="link font-semibold">
            {t('lifecycle.seeRenewal')}
          </Link>
        </Notice>
      ) : null}
      {detail.renewsSubscriptionId ? (
        <Notice tone="info">
          {t('lifecycle.isRenewal')}{' '}
          <Link
            href={`/my-apps/requests/${detail.renewsSubscriptionId}`}
            className="link font-semibold"
          >
            {t('lifecycle.seeRenewed')}
          </Link>
        </Notice>
      ) : null}
      {detail.status === 'info_requested' && question ? (
        <Notice tone="warning">
          <p className="font-semibold">{t('lifecycle.providerAsks')}</p>
          <p className="whitespace-pre-line">{question.comment}</p>
        </Notice>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SubscriptionFacts detail={detail} side="consumer" />
        <AuditTimeline items={timeline} />
      </div>
      {developer && detail.status === 'info_requested' ? (
        <Section title={t('lifecycle.answer')}>
          <div className="card max-w-3xl p-6 md:p-8">
            <LifecycleForm
              side="consumer"
              subscriptionId={detail.id}
              step="provide-info"
              label={t('lifecycle.answer')}
              commentLabel={t('lifecycle.yourAnswer')}
              commentRequired
              corrections={{
                purposeDetail: detail.purposeDetail,
                legalBasisText: detail.legalBasisText,
              }}
            />
          </div>
        </Section>
      ) : null}
      {developer && detail.status === 'active' && !detail.renewal ? (
        <Section title={t('lifecycle.renew')} description={t('lifecycle.renewHint')}>
          <Link href={renewHref} className={buttonVariants({ variant: 'outline' })}>
            {t('lifecycle.renew')}
          </Link>
        </Section>
      ) : null}
      {developer && pending ? (
        <Section title={t('lifecycle.withdraw')}>
          <div className="card max-w-3xl p-6 md:p-8">
            <LifecycleForm
              side="consumer"
              subscriptionId={detail.id}
              step="withdraw"
              label={t('lifecycle.withdraw')}
              hint={t('lifecycle.withdrawHint')}
              commentLabel={t('lifecycle.optionalComment')}
              commentRequired={false}
              variant="danger"
            />
          </div>
        </Section>
      ) : null}
    </Page>
  );
}
