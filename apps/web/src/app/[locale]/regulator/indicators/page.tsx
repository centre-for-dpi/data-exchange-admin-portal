import { networkIndicatorsSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Notice } from '../../../../components/ui/notice';
import { Page, PageHeader } from '../../../../components/ui/page';
import { MonthlyChart } from '../../../../components/usage/daily-chart';
import { BreakdownTable, Stat, UsageFilters } from '../../../../components/usage/usage-parts';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'indicators' });
  return { title: t('title') };
}

/** Roles that see the network's indicators (network.indicators.read). */
const ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The network's indicators (SPEC.md §8, M5-04) for the regulator and the operator. */
export default async function IndicatorsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => ROLES.includes(r))) notFound();
  const back = viewer.platformRoles.includes('regulator') ? '/regulator' : '/operator';
  const header = (
    <PageHeader
      title={t('indicators.title')}
      description={t('indicators.lead')}
      actions={
        <Link href={back} className="link">
          {t(back === '/regulator' ? 'nav.regulator' : 'nav.operator')}
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
  let data;
  try {
    data = await apiGet(`/network/indicators${qs ? `?${qs}` : ''}`, networkIndicatorsSchema);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 503 || error.status === 400)) {
      return (
        <Page>
          {header}
          <Notice tone={error.status === 503 ? 'warning' : 'danger'}>
            {error.status === 503 ? t('usage.unavailable') : t('usage.badPeriod')}
          </Notice>
          <p>
            <Link href="/regulator/indicators" className="link">
              {t('usage.reset')}
            </Link>
          </p>
        </Page>
      );
    }
    throw error;
  }

  const n = (v: number) => format.number(v);
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const { successfulCalls: calls, apisInUse, timeToFirstUse, approvalTime } = data;
  const counted = calls.calls - calls.authorizationRefused;
  const reason = (code: string) =>
    t.has(`usage.reasons.${code}`) ? t(`usage.reasons.${code}`) : code;
  const withUse = timeToFirstUse.entities.filter((e) => e.days !== null).length;

  return (
    <Page>
      {header}
      <UsageFilters period={data.period} />
      <p className="text-sm text-muted-foreground">
        {t('indicators.periodLine', {
          from: format.dateTime(new Date(`${data.period.from}T12:00:00Z`), {
            dateStyle: 'long',
            timeZone: 'UTC',
          }),
          to: format.dateTime(new Date(`${data.period.to}T12:00:00Z`), {
            dateStyle: 'long',
            timeZone: 'UTC',
          }),
          timeZone: data.period.timeZone,
        })}
      </p>

      <dl className="usage-stats">
        <Stat
          label={t('indicators.successful.label')}
          value={
            calls.rate === null
              ? '—'
              : format.number(calls.rate, { style: 'percent', maximumFractionDigits: 1 })
          }
          hint={t('indicators.successful.hint', {
            ok: calls.ok,
            counted,
            refused: calls.authorizationRefused,
          })}
        />
        <Stat
          label={t('indicators.availability.label')}
          value={
            data.gatewayAvailability.percent === null
              ? t('indicators.noData')
              : `${format.number(data.gatewayAvailability.percent, { maximumFractionDigits: 2 })} %`
          }
          hint={t('indicators.availability.hint')}
        />
        <Stat
          label={t('indicators.apisInUse.label')}
          value={t('indicators.apisInUse.value', {
            inUse: apisInUse.inUse,
            published: apisInUse.published,
          })}
          hint={t('indicators.apisInUse.hint')}
        />
        <Stat
          label={t('indicators.approval.label')}
          value={
            approvalTime.medianHours === null
              ? t('indicators.noData')
              : t('indicators.approval.value', { hours: approvalTime.medianHours })
          }
          hint={t('indicators.approval.hint', { decisions: approvalTime.decisions })}
        />
        <Stat
          label={t('indicators.firstUse.label')}
          value={
            timeToFirstUse.medianDays === null
              ? t('indicators.noData')
              : t('indicators.firstUse.value', { days: timeToFirstUse.medianDays })
          }
          hint={t('indicators.firstUse.hint', {
            withUse,
            total: timeToFirstUse.entities.length,
          })}
        />
        <Stat
          label={t('indicators.manualSteps.label')}
          value={n(data.manualStepsAvoided.total)}
          hint={t('indicators.manualSteps.hint', { useCases: data.manualStepsAvoided.useCases })}
        />
      </dl>

      <MonthlyChart
        months={data.connectedEntities.byMonth}
        title={t('indicators.connected.title', { total: data.connectedEntities.total })}
      />

      <div className="usage-grid">
        <BreakdownTable
          title={t('indicators.apisInUse.table')}
          rows={apisInUse.items}
          rowKey={(r) => r.apiId}
          columns={[
            { header: t('usage.columns.api'), cell: (r) => r.apiName },
            { header: t('usage.columns.provider'), cell: (r) => r.providerName },
            { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
          ]}
        />
        <BreakdownTable
          title={t('indicators.successful.refusedTable')}
          rows={calls.refusedByReason}
          rowKey={(r) => r.reason}
          columns={[
            {
              header: t('usage.columns.reason'),
              cell: (r) => (
                <>
                  {reason(r.reason)} <code>{r.reason}</code>
                </>
              ),
            },
            { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
          ]}
        />
      </div>
      <BreakdownTable
        title={t('indicators.firstUse.table')}
        rows={timeToFirstUse.entities}
        rowKey={(r) => r.entityId}
        columns={[
          { header: t('indicators.firstUse.entity'), cell: (r) => r.name },
          {
            header: t('indicators.firstUse.since'),
            cell: (r) =>
              t(
                r.sinceKind === 'node'
                  ? 'indicators.firstUse.node'
                  : 'indicators.firstUse.onboarding',
                {
                  date: day(r.since),
                },
              ),
          },
          {
            header: t('indicators.firstUse.firstCall'),
            cell: (r) => (r.firstCallAt ? day(r.firstCallAt) : t('indicators.firstUse.none')),
          },
          {
            header: t('indicators.firstUse.days'),
            cell: (r) => (r.days === null ? '—' : n(r.days)),
            numeric: true,
          },
        ]}
      />
    </Page>
  );
}
