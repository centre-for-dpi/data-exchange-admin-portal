import { SYNC_STATUSES, SYNC_SYSTEMS, syncPageSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { inputClass } from '../../../../components/form/field';
import { NodeContractBadge, NodeContractDetails } from '../../../../components/nodes/node-contract';
import { RetrySyncButton } from '../../../../components/sync/retry-button';
import { Badge, type Tone } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Notice } from '../../../../components/ui/notice';
import { EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { UsageFilter } from '../../../../components/usage/usage-parts';
import { Link } from '../../../../i18n/navigation';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'syncConsole' });
  return { title: t('title') };
}

const ROLES = ['platform_admin', 'platform_reviewer'];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TONE: Record<string, Tone> = {
  in_sync: 'success',
  pending: 'info',
  drift: 'warning',
  error: 'danger',
};

/** The operator's sync console (SPEC.md §6, M5-07): the gateway's sync state and drift. */
export default async function SyncConsolePage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => ROLES.includes(r))) notFound();
  const canRetry = viewer.platformRoles.includes('platform_admin');

  const query = await searchParams;
  const filters = {
    system: one(query.system),
    status: one(query.status) ?? 'problems',
    q: one(query.q),
    cursor: one(query.cursor),
  };
  const qs = new URLSearchParams(
    Object.entries({
      ...filters,
      status: filters.status === 'all' ? undefined : filters.status,
    }).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const page = await apiGet(`/admin/sync?${qs}`, syncPageSchema);
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const systems = [...new Set(page.summary.map((s) => s.system))];
  const count = (system: string, status: string) =>
    page.summary.find((s) => s.system === system && s.status === status)?.count ?? 0;
  const next = page.nextCursor
    ? `?${new URLSearchParams(
        Object.entries({ ...filters, cursor: page.nextCursor }).filter((e): e is [string, string] =>
          Boolean(e[1]),
        ),
      ).toString()}`
    : null;

  return (
    <Page>
      <PageHeader
        eyebrow={t('nav.operator')}
        title={t('syncConsole.title')}
        description={t('syncConsole.lead')}
        actions={
          <Link href="/operator" className="link">
            {t('nav.operator')}
          </Link>
        }
      />
      {page.recentDrift > 0 ? (
        <Notice tone="warning" role="status">
          {t('syncConsole.recentDrift', { count: page.recentDrift })}
        </Notice>
      ) : null}

      <Section title={t('syncConsole.summary')}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('syncConsole.system')}</th>
                {SYNC_STATUSES.map((s) => (
                  <th key={s} scope="col" className="text-right">
                    {t(`syncConsole.statuses.${s}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {systems.map((system) => (
                <tr key={system}>
                  <th scope="row" className="font-medium">
                    {t(`syncConsole.systems.${system}`)}
                  </th>
                  {SYNC_STATUSES.map((s) => (
                    <td key={s} className="text-right tabular-nums">
                      {format.number(count(system, s))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {page.disallowedUpstreams.length > 0 ? (
        // P-04: versions still served on a channel the country no longer accepts.
        <Section
          title={t('syncConsole.disallowedTitle')}
          description={t('syncConsole.disallowedLead')}
        >
          <div className="table-wrap" data-testid="disallowed-upstreams">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('syncConsole.disallowedApi')}</th>
                  <th scope="col">{t('syncConsole.disallowedEntity')}</th>
                  <th scope="col">{t('syncConsole.status')}</th>
                  <th scope="col">{t('syncConsole.disallowedTypes')}</th>
                </tr>
              </thead>
              <tbody>
                {page.disallowedUpstreams.map((row) => (
                  <tr key={row.versionId}>
                    <td>
                      <Link href={`/operator/reviews/${row.versionId}`} className="link">
                        {row.apiName} {row.version}
                      </Link>
                    </td>
                    <td className="text-sm">{row.entityName}</td>
                    <td>
                      <Badge tone="neutral">
                        {t.has(`versionStatus.${row.status}`)
                          ? t(`versionStatus.${row.status}`)
                          : row.status}
                      </Badge>
                    </td>
                    <td className="text-sm">
                      {format.list(
                        row.types.map((type) => t(`version.detail.upstreamTypeNames.${type}`)),
                        { type: 'conjunction' },
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {page.nodeContracts.length > 0 ? (
        // P-02: nodes serving a contract other than the published one, or reporting none.
        <Section title={t('nodeContract.consoleTitle')} description={t('nodeContract.consoleLead')}>
          <div className="table-wrap" data-testid="node-contracts">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('nodeContract.version')}</th>
                  <th scope="col">{t('syncConsole.disallowedEntity')}</th>
                  <th scope="col">{t('nodes.name')}</th>
                  <th scope="col">{t('nodeContract.column')}</th>
                </tr>
              </thead>
              <tbody>
                {page.nodeContracts.map((row) => (
                  <tr key={row.apiVersionId}>
                    <td>
                      <Link href={`/operator/reviews/${row.apiVersionId}`} className="link">
                        {row.apiName} {row.version}
                      </Link>
                      <span className="block font-mono text-sm text-muted-foreground">
                        {row.servicePath}
                      </span>
                    </td>
                    <td className="text-sm">{row.entityName}</td>
                    <td className="text-sm">{row.nodeName}</td>
                    <td className="space-y-2">
                      <NodeContractBadge status={row.status} />
                      <NodeContractDetails contract={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <form method="get" className="usage-filters" aria-label={t('syncConsole.filters')}>
        <UsageFilter id="sync-status" label={t('syncConsole.status')}>
          <select
            id="sync-status"
            name="status"
            defaultValue={filters.status}
            className={inputClass}
          >
            <option value="problems">{t('syncConsole.problems')}</option>
            <option value="all">{t('syncConsole.all')}</option>
            {SYNC_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`syncConsole.statuses.${s}`)}
              </option>
            ))}
          </select>
        </UsageFilter>
        <UsageFilter id="sync-system" label={t('syncConsole.system')}>
          <select
            id="sync-system"
            name="system"
            defaultValue={filters.system ?? ''}
            className={inputClass}
          >
            <option value="">{t('syncConsole.allSystems')}</option>
            {SYNC_SYSTEMS.map((s) => (
              <option key={s} value={s}>
                {t(`syncConsole.systems.${s}`)}
              </option>
            ))}
          </select>
        </UsageFilter>
        <UsageFilter id="sync-q" label={t('syncConsole.search')}>
          <input id="sync-q" name="q" defaultValue={filters.q ?? ''} className={inputClass} />
        </UsageFilter>
        <Button type="submit" variant="outline">
          {t('usage.filters.apply')}
        </Button>
      </form>

      {page.items.length === 0 ? (
        <EmptyState>{t('syncConsole.empty')}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('syncConsole.target')}</th>
                <th scope="col">{t('syncConsole.status')}</th>
                <th scope="col">{t('syncConsole.appliedAt')}</th>
                <th scope="col">{t('syncConsole.drift')}</th>
                <th scope="col">{t('syncConsole.lastError')}</th>
                {canRetry ? <th scope="col">{t('syncConsole.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {page.items.map((row) => (
                <tr key={row.target}>
                  <td>
                    <code className="break-all text-xs">{row.target}</code>
                    <div className="text-xs text-muted-foreground">
                      {t(`syncConsole.systems.${row.system}`)}
                    </div>
                  </td>
                  <td>
                    <Badge tone={TONE[row.status] ?? 'neutral'} dot>
                      {t(`syncConsole.statuses.${row.status}`)}
                    </Badge>
                    {row.attempts > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        {t('syncConsole.attempts', { attempts: row.attempts })}
                      </div>
                    ) : null}
                  </td>
                  <td className="text-sm">
                    {when(row.appliedAt)}
                    {!row.applied ? (
                      <div className="text-xs text-muted-foreground">
                        {t('syncConsole.notApplied')}
                      </div>
                    ) : null}
                  </td>
                  <td className="text-sm">
                    {row.driftDetectedAt
                      ? t('syncConsole.driftAt', {
                          when: when(row.driftDetectedAt),
                          count: row.driftCount,
                        })
                      : '—'}
                  </td>
                  <td className="max-w-xs text-sm">
                    {row.lastError ? <span className="break-words">{row.lastError}</span> : '—'}
                  </td>
                  {canRetry ? (
                    <td>
                      <RetrySyncButton target={row.target} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next ? (
        <p>
          <a href={next} className="link">
            {t('syncConsole.next')}
          </a>
        </p>
      ) : null}
    </Page>
  );
}
