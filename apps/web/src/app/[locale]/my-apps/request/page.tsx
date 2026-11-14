import { getCountryConfig } from '@rid/config';
import {
  applicationPageSchema,
  catalogDetailSchema,
  subscriptionDetailSchema,
} from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { RequestAccessForm } from '../../../../components/subscriptions/subscription-forms';
import { Button } from '../../../../components/ui/button';
import { EmptyState, Page, PageHeader } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet, apiGetAll } from '../../../../lib/api';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const param = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

async function loadApi(apiId: string) {
  try {
    return await apiGet(`/catalog/apis/${apiId}`, catalogDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && [400, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'subscriptions' });
  return { title: t('requestAccess') };
}

export default async function RequestAccessPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('subscriptions');
  const entity = (await getViewer()).activeEntity;
  if (!entity?.roles.includes('app_developer')) notFound();

  const query = await searchParams;
  const detail = await loadApi(param(query.api));
  const version = detail.versions.find((v) => v.id === param(query.version)) ?? detail.versions[0];
  // Only published versions take new requests.
  if (!version || version.status !== 'published') notFound();

  const apps = await apiGetAll(`/entities/${entity.entity.id}/applications`, applicationPageSchema);
  // A renewal (?renew=<id>) keeps the application and purpose of the subscription it renews and
  // starts from what it had; the API checks it again (M2-06).
  const renewed = param(query.renew)
    ? await apiGet(
        `/entities/${entity.entity.id}/subscriptions/${param(query.renew)}`,
        subscriptionDetailSchema,
      ).catch(() => notFound())
    : null;
  if (renewed && renewed.version.id !== version.id) notFound();
  const active = apps.items.filter(
    (a) => a.status === 'active' && (!renewed || a.id === renewed.application.id),
  );
  const maxMonths = getCountryConfig().subscriptionMaxValidityMonths[detail.api.classification];

  return (
    <Page>
      <PageHeader
        title={
          renewed
            ? t('lifecycle.renewTitle', { api: detail.api.name })
            : t('form.title', { api: detail.api.name })
        }
        description={t('form.version', {
          version: version.version,
          provider: detail.entity.legalName,
        })}
      />
      {active.length === 0 ? (
        <EmptyState
          action={
            <Button asChild>
              <Link href="/my-apps/new">{(await getTranslations('myApps'))('newApp')}</Link>
            </Button>
          }
        >
          {t('form.noApplications')}
        </EmptyState>
      ) : (
        <div className="card max-w-3xl p-6 md:p-8">
          <RequestAccessForm
            apiVersionId={version.id}
            applications={active.map((a) => ({ id: a.id, name: a.name }))}
            purposes={version.allowedPurposes
              .filter((p) => !renewed || p.code === renewed.purpose.code)
              .map((p) => ({
                code: p.code,
                label: localize(p.name, locale),
              }))}
            operations={version.operations}
            maxMonths={maxMonths}
            {...(renewed
              ? {
                  prefill: {
                    renewsSubscriptionId: renewed.id,
                    purposeDetail: renewed.purposeDetail,
                    legalBasisText: renewed.legalBasisText,
                    legalReference: renewed.legalReference,
                    requestedOperations: renewed.requestedOperations,
                    requestedRateLimit: renewed.requestedRateLimit,
                  },
                }
              : {})}
          />
        </div>
      )}
    </Page>
  );
}
