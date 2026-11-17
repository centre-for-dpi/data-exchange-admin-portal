import { apiPageSchema, providerUsageSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { inputClass } from '../../../../components/form/field';
import { DailyChart } from '../../../../components/usage/daily-chart';
import {
  BreakdownTable,
  UsageFilter,
  UsageFilters,
  UsageStats,
} from '../../../../components/usage/usage-parts';
import { Notice } from '../../../../components/ui/notice';
import { EmptyState, Page, PageHeader } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet, apiGetAll } from '../../../../lib/api';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'usage.provided' });
  return { title: t('title') };
}

/** Roles that see the usage of the entity's APIs (usage.provided.read). */
const ROLES = ['data_steward', 'entity_admin', 'entity_viewer', 'api_publisher'];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Usage of the entity's APIs (M5-02): who calls, for what, how they answer. */
export default async function ProvidedUsagePage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  const entity = viewer.activeEntity;
  const header = (
    <PageHeader
      eyebrow={entity?.entity.shortName}
      title={t('usage.provided.title')}
      description={t('usage.provided.lead')}
      actions={
        <Link href="/my-apis" className="link">
          {t('nav.myApis')}
        </Link>
      }
    />
  );
  if (!entity || !entity.roles.some((r) => ROLES.includes(r))) {
    return (
      <Page>
        {header}
        <EmptyState>{t('usage.provided.noAccess')}</EmptyState>
      </Page>
    );
  }

  const query = await searchParams;
  const filters = {
    from: one(query.from),
    to: one(query.to),
    apiId: one(query.apiId),
    environment: one(query.environment) === 'sandbox' ? 'sandbox' : undefined,
  };
  const qs = new URLSearchParams(
    Object.entries(filters).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const apis = await apiGetAll(`/entities/${entity.entity.id}/apis`, apiPageSchema);

  let usage;
  try {
    usage = await apiGet(
      `/entities/${entity.entity.id}/usage/provided${qs ? `?${qs}` : ''}`,
      providerUsageSchema,
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
            <Link href="/my-apis/usage" className="link">
              {t('usage.reset')}
            </Link>
          </p>
        </Page>
      );
    }
    throw error;
  }

  const n = (v: number) => format.number(v);
  return (
    <Page>
      {header}
      <UsageFilters
        period={usage.period}
        hidden={{ apiId: filters.apiId, environment: filters.environment }}
      >
        <UsageFilter id="usage-api" label={t('usage.filters.api')}>
          <select
            id="usage-api"
            name="apiId"
            defaultValue={filters.apiId ?? ''}
            className={inputClass}
          >
            <option value="">{t('usage.filters.allApis')}</option>
            {apis.items.map((api) => (
              <option key={api.id} value={api.id}>
                {api.name}
              </option>
            ))}
          </select>
        </UsageFilter>
        <UsageFilter id="usage-environment" label={t('usage.filters.environment')}>
          <select
            id="usage-environment"
            name="environment"
            defaultValue={usage.environment}
            className={inputClass}
          >
            <option value="production">{t('usage.filters.production')}</option>
            <option value="sandbox">{t('usage.filters.sandbox')}</option>
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

      <div className="usage-grid">
        <BreakdownTable
          title={t('usage.provided.byConsumer')}
          rows={usage.byConsumer}
          rowKey={(r, i) => r.entityId ?? `none-${i}`}
          columns={[
            {
              header: t('usage.columns.consumer'),
              cell: (r) => r.entityName ?? t('usage.unknownConsumer'),
            },
            { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
            { header: t('usage.columns.errors'), cell: (r) => n(r.errors), numeric: true },
          ]}
        />
        <BreakdownTable
          title={t('usage.provided.byPurpose')}
          rows={usage.byPurpose}
          rowKey={(r) => r.code}
          columns={[
            {
              header: t('usage.columns.purpose'),
              cell: (r) => (r.name ? localize(r.name, locale) : r.code),
            },
            { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
          ]}
        />
      </div>
      <BreakdownTable
        title={t('usage.provided.byOperation')}
        rows={usage.byOperation}
        rowKey={(r) => `${r.apiId}-${r.version}-${r.operation}`}
        columns={[
          { header: t('usage.columns.api'), cell: (r) => `${r.apiName} ${r.version}` },
          {
            header: t('usage.columns.operation'),
            cell: (r) => (r.operation ? <code>{r.operation}</code> : t('usage.noOperation')),
          },
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
        title={t('usage.provided.byStatus')}
        rows={usage.byStatus}
        rowKey={(r) => String(r.status)}
        columns={[
          { header: t('usage.columns.status'), cell: (r) => <code>{r.status}</code> },
          { header: t('usage.columns.calls'), cell: (r) => n(r.calls), numeric: true },
        ]}
      />
    </Page>
  );
}
