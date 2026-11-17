import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, FieldErrorKey } from '@den/contracts';
import { getCountryConfig } from '@den/config';
import { ServiceUnavailableError, ValidationError } from '../common/errors.js';
import { localDay, nextDay, startOfLocalDay } from '../common/local-day.js';
import { ACCESS_LOG_INDICES, type OpenSearch, OpenSearchUnavailableError } from './opensearch.js';

/** A usage period: calendar days in the country's time zone, both included. */
export interface UsagePeriod {
  from: string;
  to: string;
  timeZone: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const utcOf = (day: string): number => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** A calendar day `n` days after (or before) another one. */
export const addDays = (day: string, n: number): string =>
  new Date(utcOf(day) + n * DAY_MS).toISOString().slice(0, 10);

/** Days of a period, both ends included. */
export const daysIn = (from: string, to: string): number =>
  Math.round((utcOf(to) - utcOf(from)) / DAY_MS) + 1;

/** The period of a query: the last 30 days by default, at most a year. */
export function resolvePeriod(
  query: { from?: string | undefined; to?: string | undefined },
  now = new Date(),
): UsagePeriod {
  const timeZone = getCountryConfig().country.timezone;
  const to =
    query.to ??
    (query.from ? addDays(query.from, USAGE_DEFAULT_DAYS - 1) : localDay(now, timeZone));
  const from = query.from ?? addDays(to, -(USAGE_DEFAULT_DAYS - 1));
  const days = daysIn(from, to);
  if (days < 1 || days > USAGE_MAX_DAYS) {
    throw new ValidationError([
      {
        path: 'from',
        message: `The period must be 1 to ${USAGE_MAX_DAYS} days`,
        key: FieldErrorKey.PeriodTooLong,
        params: { days: USAGE_MAX_DAYS },
      },
    ]);
  }
  return { from, to, timeZone };
}

/** The `ts` range of a period, as UTC instants. */
export function periodRange(period: UsagePeriod) {
  return {
    range: {
      ts: {
        gte: startOfLocalDay(period.from, period.timeZone).toISOString(),
        lt: startOfLocalDay(nextDay(period.to), period.timeZone).toISOString(),
      },
    },
  };
}

export const ERRORS = { filter: { range: { status: { gte: 400 } } } };

/** Totals of a set of calls: answer classes and latency percentiles. */
export const TOTALS_AGGS = {
  classes: {
    filters: {
      filters: {
        ok: { range: { status: { gte: 200, lt: 300 } } },
        denied: { exists: { field: 'deny_reason' } },
        client: {
          bool: {
            filter: [{ range: { status: { gte: 400, lt: 500 } } }],
            must_not: [{ exists: { field: 'deny_reason' } }],
          },
        },
        server: { range: { status: { gte: 500 } } },
      },
    },
  },
  latency: { percentiles: { field: 'latency_ms', percents: [50, 95] } },
};

/** Calls per local day, every day of the period present. */
export function dailyAgg(period: UsagePeriod) {
  return {
    date_histogram: {
      field: 'ts',
      calendar_interval: 'day',
      time_zone: period.timeZone,
      format: 'yyyy-MM-dd',
      min_doc_count: 0,
      extended_bounds: { min: period.from, max: period.to },
    },
    aggs: { errors: ERRORS },
  };
}

export interface Bucket {
  key: string | number;
  key_as_string?: string;
  doc_count: number;
  errors?: { doc_count: number };
  [sub: string]: unknown;
}

export interface Percentiles {
  values?: Record<string, number | null>;
}

export interface SearchResult {
  hits?: { total?: { value: number } };
  aggregations?: Record<string, unknown>;
}

/** Searches the access logs; no index yet (nothing logged) is an empty result. */
export async function searchAccessLogs(
  openSearch: OpenSearch,
  body: object,
): Promise<SearchResult> {
  try {
    const res = await openSearch.request<SearchResult>(
      'POST',
      `/${ACCESS_LOG_INDICES}/_search?ignore_unavailable=true&allow_no_indices=true`,
      { size: 0, track_total_hits: true, ...body },
    );
    if (res.status !== 200) {
      throw new ServiceUnavailableError('The usage analytics are not available right now');
    }
    return res.body;
  } catch (error) {
    if (error instanceof OpenSearchUnavailableError) {
      throw new ServiceUnavailableError('The usage analytics are not available right now');
    }
    throw error;
  }
}

export const buckets = (aggs: Record<string, unknown> | undefined, name: string): Bucket[] =>
  (aggs?.[name] as { buckets?: Bucket[] } | undefined)?.buckets ?? [];

/** A percentile in milliseconds, rounded to tenths; null when there were no calls. */
export function percentile(p: unknown, percent: 50 | 95): number | null {
  const value = (p as Percentiles | undefined)?.values?.[`${percent}.0`];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

export function totals(result: SearchResult) {
  const aggs = result.aggregations;
  const classes = (aggs?.classes as { buckets?: Record<string, { doc_count: number }> } | undefined)
    ?.buckets;
  const count = (name: string) => classes?.[name]?.doc_count ?? 0;
  return {
    calls: result.hits?.total?.value ?? 0,
    ok: count('ok'),
    denied: count('denied'),
    clientErrors: count('client'),
    serverErrors: count('server'),
    latencyP50Ms: percentile(aggs?.latency, 50),
    latencyP95Ms: percentile(aggs?.latency, 95),
  };
}

export function daily(result: SearchResult, period: UsagePeriod) {
  const byDay = new Map(
    buckets(result.aggregations, 'daily').map((b) => [
      b.key_as_string ?? '',
      { calls: b.doc_count, errors: b.errors?.doc_count ?? 0 },
    ]),
  );
  // Every day of the period, also without an index (no calls logged at all).
  const days: Array<{ date: string; calls: number; errors: number }> = [];
  for (let day = period.from; day <= period.to; day = nextDay(day)) {
    days.push({ date: day, ...(byDay.get(day) ?? { calls: 0, errors: 0 }) });
  }
  return days;
}

export const emptyTotals = () => totals({});
