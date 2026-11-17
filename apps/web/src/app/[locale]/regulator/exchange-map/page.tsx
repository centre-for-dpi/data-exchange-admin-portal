import { exchangeMapSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EmptyState, Page, PageHeader } from '../../../../components/ui/page';
import { Notice } from '../../../../components/ui/notice';
import { ExchangeMap } from '../../../../components/usage/exchange-map';
import { BreakdownTable, UsageFilters } from '../../../../components/usage/usage-parts';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'exchangeMap' });
  return { title: t('title') };
}

/** Roles that see the exchange map (network.map.read). */
const ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Which entity consumes from which, with volume (SPEC.md §6, M5-05). */
export default async function ExchangeMapPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => ROLES.includes(r))) notFound();
  const header = (
    <PageHeader
      title={t('exchangeMap.title')}
      description={t('exchangeMap.lead')}
      actions={
        <Link href="/regulator/indicators" className="link">
          {t('indicators.title')}
        </Link>
      }
    />
  );
  const query = await searchParams;
  const qs = new URLSearchParams(
    Object.entries({ from: one(query.from), to: one(query.to) }).filter(
      (e): e is [string, string] => Boolean(e[1]),
    ),
  ).toString();
  let map;
  try {
    map = await apiGet(`/network/exchanges${qs ? `?${qs}` : ''}`, exchangeMapSchema);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 503 || error.status === 400)) {
      return (
        <Page>
          {header}
          <Notice tone={error.status === 503 ? 'warning' : 'danger'}>
            {error.status === 503 ? t('usage.unavailable') : t('usage.badPeriod')}
          </Notice>
        </Page>
      );
    }
    throw error;
  }
  const n = (v: number) => format.number(v);
  return (
    <Page>
      {header}
      <UsageFilters period={map.period} />
      {map.exchanges.length === 0 ? (
        <EmptyState>{t('exchangeMap.empty')}</EmptyState>
      ) : (
        <>
          <ExchangeMap exchanges={map.exchanges} title={t('exchangeMap.chartTitle')} />
          <BreakdownTable
            title={t('exchangeMap.table')}
            rows={map.exchanges}
            rowKey={(r) => `${r.consumerId}-${r.providerId}`}
            columns={[
              { header: t('usage.columns.consumer'), cell: (r) => r.consumerName },
              { header: t('usage.columns.provider'), cell: (r) => r.providerName },
              { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
              { header: t('usage.columns.errors'), cell: (r) => n(r.errors), numeric: true },
              {
                header: t('exchangeMap.subscriptions'),
                cell: (r) => n(r.activeSubscriptions),
                numeric: true,
              },
            ]}
          />
        </>
      )}
    </Page>
  );
}
