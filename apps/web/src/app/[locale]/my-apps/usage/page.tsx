import { applicationPageSchema, consumedUsageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { inputClass } from '../../../../components/form/field';
import { Badge } from '../../../../components/ui/badge';
import { Notice } from '../../../../components/ui/notice';
import { EmptyState, Page, PageHeader } from '../../../../components/ui/page';
import { DailyChart } from '../../../../components/usage/daily-chart';
import {
  BreakdownTable,
  UsageFilter,
  UsageFilters,
  UsageStats,
} from '../../../../components/usage/usage-parts';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet, apiGetAll } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'usage.consumed' });
  return { title: t('title') };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Usage of the entity's applications (M5-03): their calls, and why the gateway refused some. */
export default async function ConsumedUsagePage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  const entity = viewer.activeEntity;
  const header = (
    <PageHeader
      eyebrow={entity?.entity.shortName}
      title={t('usage.consumed.title')}
      description={t('usage.consumed.lead')}
      actions={
        <Link href="/my-apps" className="link">
          {t('nav.myApps')}
        </Link>
      }
    />
  );
  if (!entity) {
    return (
      <Page>
        {header}
        <EmptyState>{t('myApps.noEntity')}</EmptyState>
      </Page>
    );
  }

  const query = await searchParams;
  const filters = {
    from: one(query.from),
    to: one(query.to),
    applicationId: one(query.applicationId),
  };
  const qs = new URLSearchParams(
    Object.entries(filters).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const apps = await apiGetAll(`/entities/${entity.entity.id}/applications`, applicationPageSchema);

  let usage;
  try {
    usage = await apiGet(
      `/entities/${entity.entity.id}/usage/consumed${qs ? `?${qs}` : ''}`,
      consumedUsageSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && (error.status === 503 || error.status === 400)) {
      return (
        <Page>
          {header}
          <Notice tone={error.status === 503 ? 'warning' : 'danger'}>
            {error.status === 503 ? t('usage.unavailable') : t('usage.badPeriod')}
          </Notice>
          <p>
            <Link href="/my-apps/usage" className="link">
              {t('usage.reset')}
            </Link>
          </p>
        </Page>
      );
    }
    throw error;
  }

  const n = (v: number) => format.number(v);
  const reason = (code: string) =>
    t.has(`usage.reasons.${code}`) ? t(`usage.reasons.${code}`) : code;
  return (
    <Page>
      {header}
      <UsageFilters period={usage.period} hidden={{ applicationId: filters.applicationId }}>
        <UsageFilter id="usage-application" label={t('usage.filters.application')}>
          <select
            id="usage-application"
            name="applicationId"
            defaultValue={filters.applicationId ?? ''}
            className={inputClass}
          >
            <option value="">{t('usage.filters.allApplications')}</option>
            {apps.items.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
          </select>
        </UsageFilter>
      </UsageFilters>

      <p className="text-sm text-muted-foreground">
        {t('usage.periodLine', {
          from: format.dateTime(new Date(`${usage.period.from}T12:00:00Z`), {
            dateStyle: 'long',
            timeZone: 'UTC',
          }),
          to: format.dateTime(new Date(`${usage.period.to}T12:00:00Z`), {
            dateStyle: 'long',
            timeZone: 'UTC',
          }),
          timeZone: usage.period.timeZone,
        })}
      </p>

      <UsageStats totals={usage.totals} />
      <DailyChart days={usage.daily} title={t('usage.chart.title')} />

      <BreakdownTable
        title={t('usage.consumed.byApplication')}
        rows={usage.byApplication}
        rowKey={(r) => r.applicationId}
        columns={[
          {
            header: t('usage.columns.application'),
            cell: (r) => (
              <Link href={`/my-apps/${r.applicationId}`} className="link">
                {r.name}
              </Link>
            ),
          },
          {
            header: t('myApps.environment'),
            cell: (r) => (
              <Badge tone={r.environment === 'sandbox' ? 'info' : 'neutral'}>
                {t(`usage.filters.${r.environment}`)}
              </Badge>
            ),
          },
          { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
          { header: t('usage.columns.errors'), cell: (r) => n(r.errors), numeric: true },
          { header: t('usage.columns.denials'), cell: (r) => n(r.denied), numeric: true },
        ]}
      />
      <BreakdownTable
        title={t('usage.consumed.byApi')}
        rows={usage.byApi}
        rowKey={(r, i) => `${r.apiId ?? 'none'}-${r.version ?? ''}-${r.sandbox}-${i}`}
        columns={[
          {
            header: t('usage.columns.api'),
            cell: (r) =>
              r.apiName ? (
                <>
                  {`${r.apiName} ${r.version ?? ''}`}
                  {r.sandbox && (
                    <>
                      {' '}
                      <Badge tone="info">{t('usage.filters.sandbox')}</Badge>
                    </>
                  )}
                </>
              ) : (
                t('usage.consumed.unknownApi')
              ),
          },
          { header: t('usage.columns.provider'), cell: (r) => r.providerName ?? '—' },
          { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
          { header: t('usage.columns.errors'), cell: (r) => n(r.errors), numeric: true },
          {
            header: t('usage.columns.p95'),
            cell: (r) => (r.latencyP95Ms === null ? '—' : `${n(r.latencyP95Ms)} ms`),
            numeric: true,
          },
        ]}
      />
      <BreakdownTable
        title={t('usage.consumed.denials')}
        rows={usage.denials}
        rowKey={(r) => `${r.reason}-${r.applicationId}`}
        columns={[
          {
            header: t('usage.columns.reason'),
            cell: (r) => (
              <>
                {reason(r.reason)} <code>{r.reason}</code>
              </>
            ),
          },
          { header: t('usage.columns.application'), cell: (r) => r.name },
          { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
        ]}
      />
      <p className="text-sm text-muted-foreground">{t('usage.consumed.unattributed')}</p>
    </Page>
  );
}
