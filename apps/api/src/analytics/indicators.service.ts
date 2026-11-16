import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IndicatorsQuery, NetworkIndicators } from '@rid/contracts';
import { localDay, nextDay, startOfLocalDay } from '../common/local-day.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ROUTE_PREFIX } from '../reconcilers/apisix/desired-state.js';
import { OPENSEARCH, type OpenSearch } from './opensearch.js';
import { PROMETHEUS, type Prometheus } from './prometheus.js';
import {
  buckets,
  periodRange,
  resolvePeriod,
  searchAccessLogs,
  type UsagePeriod,
} from './usage-query.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Real traffic only: the production routes, never the sandbox's or the validation checks'. */
const PRODUCTION = { prefix: { route_id: ROUTE_PREFIX } };
const SUCCESS = { range: { status: { gte: 200, lt: 300 } } };
/** One bucket per version route; more versions than this are not expected in one network. */
const ROUTES = 10_000;
/** Months of the "connected entities" series. */
const MONTHS = 12;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(value * 10) / 10;
}

const versionIdOf = (route: string): string | undefined => {
  const id = route.startsWith(ROUTE_PREFIX) ? route.slice(ROUTE_PREFIX.length) : '';
  return UUID.test(id) ? id : undefined;
};

/** The `count` months ending with `last` (YYYY-MM), oldest first. */
export function monthsUpTo(last: string, count: number): string[] {
  const [y = 0, m = 1] = last.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/**
 * The network's indicators (SPEC.md §8, M5-04): from the access logs (OpenSearch), the portal's
 * own data (PostgreSQL, the audit trail) and the gateway's health (Prometheus, when there is one).
 */
@Injectable()
export class IndicatorsService {
  private readonly logger = new Logger(IndicatorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPENSEARCH) private readonly openSearch: OpenSearch,
    @Inject(PROMETHEUS) private readonly prometheus: Prometheus | null,
  ) {}

  async network(query: IndicatorsQuery): Promise<NetworkIndicators> {
    const period = resolvePeriod(query);
    const [traffic, firstCalls] = await Promise.all([
      searchAccessLogs(this.openSearch, {
        query: { bool: { filter: [periodRange(period), PRODUCTION] } },
        aggs: {
          ok: { filter: SUCCESS, aggs: { routes: { terms: { field: 'route_id', size: ROUTES } } } },
          refused: { filter: { terms: { status: [401, 403] } } },
          reasons: { terms: { field: 'deny_reason', size: 50 } },
        },
      }),
      // The first successful call of every route, whenever it was (within the logs' retention).
      searchAccessLogs(this.openSearch, {
        query: { bool: { filter: [PRODUCTION, SUCCESS] } },
        aggs: {
          routes: {
            terms: { field: 'route_id', size: ROUTES },
            aggs: { first: { min: { field: 'ts' } } },
          },
        },
      }),
    ]);

    const aggs = traffic.aggregations ?? {};
    const calls = traffic.hits?.total?.value ?? 0;
    const ok = (aggs.ok as { doc_count?: number } | undefined)?.doc_count ?? 0;
    const refused = (aggs.refused as { doc_count?: number } | undefined)?.doc_count ?? 0;
    const counted = calls - refused;

    const [apisInUse, timeToFirstUse, connectedEntities, approvalTime, availability, steps] =
      await Promise.all([
        this.apisInUse(buckets(aggs.ok as Record<string, unknown>, 'routes')),
        this.timeToFirstUse(buckets(firstCalls.aggregations, 'routes')),
        this.connectedEntities(period),
        this.approvalTime(period),
        this.availability(period),
        this.manualSteps(),
      ]);

    return {
      period,
      successfulCalls: {
        calls,
        ok,
        authorizationRefused: refused,
        rate: counted > 0 ? Math.round((ok / counted) * 10_000) / 10_000 : null,
        refusedByReason: buckets(aggs, 'reasons').map((b) => ({
          reason: String(b.key),
          calls: b.doc_count,
        })),
      },
      apisInUse,
      timeToFirstUse,
      connectedEntities,
      approvalTime,
      gatewayAvailability: { percent: availability },
      manualStepsAvoided: steps,
    };
  }

  private async apisInUse(routes: Array<{ key: string | number; doc_count: number }>) {
    const callsByVersion = new Map<string, number>();
    for (const b of routes) {
      const id = versionIdOf(String(b.key));
      if (id) callsByVersion.set(id, b.doc_count);
    }
    const [versions, published] = await Promise.all([
      this.prisma.apiVersion.findMany({
        where: { id: { in: [...callsByVersion.keys()] } },
        select: {
          id: true,
          api: { select: { id: true, name: true, entity: { select: { shortName: true } } } },
        },
      }),
      this.prisma.api.count({ where: { status: { in: ['published', 'deprecated'] } } }),
    ]);
    const byApi = new Map<
      string,
      { apiId: string; apiName: string; providerName: string; calls: number }
    >();
    for (const v of versions) {
      const row = byApi.get(v.api.id) ?? {
        apiId: v.api.id,
        apiName: v.api.name,
        providerName: v.api.entity.shortName,
        calls: 0,
      };
      row.calls += callsByVersion.get(v.id) ?? 0;
      byApi.set(v.api.id, row);
    }
    const items = [...byApi.values()].sort((a, b) => b.calls - a.calls);
    return { published, inUse: items.length, items };
  }

  private async timeToFirstUse(routes: Array<{ key: string | number; [k: string]: unknown }>) {
    const firstByVersion = new Map<string, number>();
    for (const b of routes) {
      const id = versionIdOf(String(b.key));
      const first = (b.first as { value?: number | null } | undefined)?.value;
      if (id && typeof first === 'number') firstByVersion.set(id, first);
    }
    // Provider entities: those with a version that was ever published.
    const providers = await this.prisma.entity.findMany({
      where: { apis: { some: { versions: { some: { publishedAt: { not: null } } } } } },
      select: {
        id: true,
        shortName: true,
        createdAt: true,
        nodes: { where: { enrolledAt: { not: null } }, select: { enrolledAt: true } },
        apis: { select: { versions: { select: { id: true } } } },
      },
      orderBy: { shortName: 'asc' },
    });
    const entities = providers.map((e) => {
      const firsts = e.apis
        .flatMap((a) => a.versions.map((v) => firstByVersion.get(v.id)))
        .filter((t): t is number => t !== undefined);
      const firstCall = firsts.length > 0 ? Math.min(...firsts) : null;
      const enrolled = e.nodes
        .map((n) => n.enrolledAt?.getTime() ?? Infinity)
        .reduce((a, b) => Math.min(a, b), Infinity);
      // The node's enrollment starts the clock when it came before the first call (the kit's
      // way into the network); otherwise the entity's onboarding does.
      const useNode = Number.isFinite(enrolled) && (firstCall === null || enrolled <= firstCall);
      const since = useNode ? enrolled : e.createdAt.getTime();
      return {
        entityId: e.id,
        name: e.shortName,
        since: new Date(since).toISOString(),
        sinceKind: useNode ? ('node' as const) : ('entity' as const),
        firstCallAt: firstCall === null ? null : new Date(firstCall).toISOString(),
        days:
          firstCall === null
            ? null
            : Math.round((Math.max(0, firstCall - since) / DAY_MS) * 10) / 10,
      };
    });
    return {
      medianDays: median(entities.flatMap((e) => (e.days === null ? [] : [e.days]))),
      entities,
    };
  }

  private async connectedEntities(period: UsagePeriod) {
    const end = startOfLocalDay(nextDay(period.to), period.timeZone);
    const firsts = await this.prisma.apiVersion.groupBy({
      by: ['apiId'],
      where: { publishedAt: { not: null, lt: end } },
      _min: { publishedAt: true },
    });
    const apis = await this.prisma.api.findMany({
      where: { id: { in: firsts.map((f) => f.apiId) } },
      select: { id: true, entityId: true },
    });
    const entityOf = new Map(apis.map((a) => [a.id, a.entityId]));
    const firstByEntity = new Map<string, Date>();
    for (const f of firsts) {
      const entityId = entityOf.get(f.apiId);
      const at = f._min.publishedAt;
      if (!entityId || !at) continue;
      const known = firstByEntity.get(entityId);
      if (!known || at < known) firstByEntity.set(entityId, at);
    }
    const monthOf = (at: Date) => localDay(at, period.timeZone).slice(0, 7);
    const months = monthsUpTo(period.to.slice(0, 7), MONTHS);
    const firstMonths = [...firstByEntity.values()].map(monthOf);
    return {
      total: firstByEntity.size,
      byMonth: months.map((month) => ({
        month,
        count: firstMonths.filter((m) => m === month).length,
        cumulative: firstMonths.filter((m) => m <= month).length,
      })),
    };
  }

  /** The provider's first decision on each request decided in the period, by a person. */
  private async approvalTime(period: UsagePeriod) {
    const events = await this.prisma.auditEvent.findMany({
      where: {
        action: { in: ['subscription.approved', 'subscription.rejected'] },
        actorType: 'user',
        targetType: 'subscription',
        occurredAt: {
          gte: startOfLocalDay(period.from, period.timeZone),
          lt: startOfLocalDay(nextDay(period.to), period.timeZone),
        },
      },
      select: { targetId: true, occurredAt: true },
      orderBy: { occurredAt: 'asc' },
    });
    const decided = new Map<string, Date>();
    for (const e of events) if (!decided.has(e.targetId)) decided.set(e.targetId, e.occurredAt);
    const subscriptions = await this.prisma.subscription.findMany({
      where: { id: { in: [...decided.keys()].filter((id) => UUID.test(id)) } },
      select: { id: true, createdAt: true },
    });
    const hours = subscriptions.flatMap((s) => {
      const at = decided.get(s.id);
      return at ? [Math.max(0, at.getTime() - s.createdAt.getTime()) / 3_600_000] : [];
    });
    return { medianHours: median(hours), decisions: hours.length };
  }

  /** Share of the period the gateway's metrics endpoint answered Prometheus (job apisix). */
  private async availability(period: UsagePeriod): Promise<number | null> {
    if (!this.prometheus) return null;
    const start = startOfLocalDay(period.from, period.timeZone).getTime();
    const end = Math.min(
      startOfLocalDay(nextDay(period.to), period.timeZone).getTime(),
      Date.now(),
    );
    const seconds = Math.floor((end - start) / 1000);
    if (seconds <= 0) return null;
    try {
      const value = await this.prometheus.instant(
        `avg_over_time(up{job="apisix"}[${seconds}s])`,
        new Date(end),
      );
      return value === null ? null : Math.round(value * 100_000) / 1_000;
    } catch (error) {
      this.logger.warn(`Gateway availability from Prometheus failed: ${String(error)}`);
      return null;
    }
  }

  private async manualSteps() {
    const rows = await this.prisma.bootcampChecklistItem.findMany({
      where: { item: 'use_case', status: 'done', manualStepsAvoided: { not: null } },
      select: { manualStepsAvoided: true },
    });
    return {
      total: rows.reduce((sum, r) => sum + (r.manualStepsAvoided ?? 0), 0),
      useCases: rows.length,
    };
  }
}
