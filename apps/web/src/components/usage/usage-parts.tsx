import { useFormatter, useTranslations } from 'next-intl';
import { type ReactNode, useId } from 'react';
import { inputClass } from '../form/field';
import { Button } from '../ui/button';

export interface UsagePeriodValue {
  from: string;
  to: string;
}

export interface UsageTotalsValue {
  calls: number;
  ok: number;
  denied: number;
  clientErrors: number;
  serverErrors: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

/** A calendar day `n` days after (or before) another one. */
export function addDays(day: string, n: number): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** One filter: its label tied to the control by id (the label never wraps a select's options). */
export function UsageFilter({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="usage-filter">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/**
 * Filters of a usage view, in one row above everything they scope: the period first (presets,
 * then the range), then the view's own selects. A plain GET form: the URL keeps the selection.
 */
export function UsageFilters({
  period,
  children,
  hidden,
}: {
  period: UsagePeriodValue;
  children?: ReactNode;
  /** Values the presets keep (the view's other filters). */
  hidden?: Record<string, string | undefined>;
}) {
  const t = useTranslations('usage');
  const keep = Object.entries(hidden ?? {}).filter(([, v]) => v);
  const preset = (days: number) => {
    const params = new URLSearchParams(keep as Array<[string, string]>);
    params.set('from', addDays(period.to, -(days - 1)));
    params.set('to', period.to);
    return `?${params.toString()}`;
  };
  return (
    <form method="get" className="usage-filters" aria-label={t('filters.label')}>
      <nav aria-label={t('filters.presets')} className="flex flex-wrap gap-2 text-sm">
        {[7, 30, 90].map((days) => (
          <a key={days} href={preset(days)} className="link">
            {t('filters.lastDays', { days })}
          </a>
        ))}
      </nav>
      <UsageFilter id="usage-from" label={t('filters.from')}>
        <input
          id="usage-from"
          type="date"
          name="from"
          defaultValue={period.from}
          required
          className={inputClass}
        />
      </UsageFilter>
      <UsageFilter id="usage-to" label={t('filters.to')}>
        <input
          id="usage-to"
          type="date"
          name="to"
          defaultValue={period.to}
          required
          className={inputClass}
        />
      </UsageFilter>
      {children}
      <Button type="submit" variant="outline">
        {t('filters.apply')}
      </Button>
    </form>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="usage-stat">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** Totals of the period as stat tiles; percentages over all calls. */
export function UsageStats({ totals }: { totals: UsageTotalsValue }) {
  const t = useTranslations('usage');
  const format = useFormatter();
  const share = (n: number) =>
    totals.calls === 0
      ? '—'
      : format.number(n / totals.calls, { style: 'percent', maximumFractionDigits: 1 });
  const ms = (v: number | null) => (v === null ? '—' : `${format.number(v)} ms`);
  return (
    <dl className="usage-stats">
      <Stat label={t('stats.calls')} value={format.number(totals.calls)} />
      <Stat label={t('stats.ok')} value={share(totals.ok)} hint={format.number(totals.ok)} />
      <Stat
        label={t('stats.denied')}
        value={format.number(totals.denied)}
        hint={t('stats.deniedHint')}
      />
      <Stat
        label={t('stats.errors')}
        value={format.number(totals.clientErrors + totals.serverErrors)}
        hint={t('stats.errorsHint', {
          client: totals.clientErrors,
          server: totals.serverErrors,
        })}
      />
      <Stat label={t('stats.p50')} value={ms(totals.latencyP50Ms)} />
      <Stat label={t('stats.p95')} value={ms(totals.latencyP95Ms)} />
    </dl>
  );
}

export interface BreakdownColumn<R> {
  header: string;
  cell: (row: R) => ReactNode;
  numeric?: boolean;
}

/** One breakdown of the usage as a table, with its own heading; a line when it is empty. */
export function BreakdownTable<R>({
  title,
  rows,
  columns,
  rowKey,
}: {
  title: string;
  rows: R[];
  columns: Array<BreakdownColumn<R>>;
  rowKey: (row: R, index: number) => string;
}) {
  const t = useTranslations('usage');
  const headingId = useId();
  return (
    <section className="usage-breakdown" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noCalls')}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.header} scope="col" className={c.numeric ? 'text-right' : undefined}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={rowKey(row, i)}>
                  {columns.map((c) => (
                    <td
                      key={c.header}
                      className={c.numeric ? 'text-right tabular-nums' : undefined}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
