import { Inject, Injectable } from '@nestjs/common';
import type { ProviderUsage, UsageQuery } from '@rid/contracts';
import { NotFoundError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';
import { routeId, sandboxRouteId } from '../reconcilers/apisix/desired-state.js';
import { OPENSEARCH, type OpenSearch } from './opensearch.js';
import {
  type Bucket,
  buckets,
  daily,
  dailyAgg,
  ERRORS,
  emptyTotals,
  percentile,
  periodRange,
  resolvePeriod,
  searchAccessLogs,
  TOTALS_AGGS,
  totals,
  type UsagePeriod,
} from './usage-query.js';

/** Group size of a breakdown: more groups than this are left out (the largest come first). */
const GROUPS = 200;
/** Gateway's key for calls it could not attribute (no known consumer, no purpose). */
const NONE = '__none__';

const errorsOf = (b: Bucket) => b.errors?.doc_count ?? 0;

/**
 * Usage analytics from the access logs in OpenSearch (M5-02, M5-03). Every query is scoped in
 * PostgreSQL first: the routes of the entity's own versions (as provider) or its own
 * applications (as consumer), so an entity never sees another one's calls. OpenSearch only holds
 * metadata (ARCHITECTURE.md §8).
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPENSEARCH) private readonly openSearch: OpenSearch,
  ) {}

  /** Calls to the entity's APIs: by consumer, purpose, operation and answer code (M5-02). */
  async provided(entityId: string, query: UsageQuery): Promise<ProviderUsage> {
    const period = resolvePeriod(query);
    const apis = await scopedRepo(this.prisma.api, entityId).findMany({
      where: query.apiId ? { id: query.apiId } : {},
    });
    if (query.apiId && apis.length === 0) throw new NotFoundError('API');
    const versions = await this.prisma.apiVersion.findMany({
      where: { apiId: { in: apis.map((a) => a.id) } },
      select: { id: true, version: true, apiId: true },
    });
    const apiById = new Map(apis.map((a) => [a.id, a]));
    const sandbox = query.environment === 'sandbox';
    const routes = new Map(
      versions.map((v) => [
        sandbox ? sandboxRouteId(v.id) : routeId(v.id),
        { apiId: v.apiId, apiName: apiById.get(v.apiId)?.name ?? '', version: v.version },
      ]),
    );
    if (routes.size === 0) return emptyProviderUsage(period, query.environment);

    const result = await searchAccessLogs(this.openSearch, {
      query: {
        bool: { filter: [periodRange(period), { terms: { route_id: [...routes.keys()] } }] },
      },
      aggs: {
        ...TOTALS_AGGS,
        daily: dailyAgg(period),
        consumers: {
          terms: { field: 'consumer_entity', size: GROUPS, missing: NONE },
          aggs: { errors: ERRORS },
        },
        purposes: { terms: { field: 'purpose', size: GROUPS } },
        routes: {
          terms: { field: 'route_id', size: GROUPS },
          aggs: {
            operations: {
              terms: { field: 'operation', size: GROUPS, missing: NONE },
              aggs: {
                errors: ERRORS,
                latency: { percentiles: { field: 'latency_ms', percents: [95] } },
              },
            },
          },
        },
        statuses: { terms: { field: 'status', size: 50, order: { _key: 'asc' } } },
      },
    });
    const aggs = result.aggregations;

    const consumerBuckets = buckets(aggs, 'consumers');
    const slugs = consumerBuckets.map((b) => String(b.key)).filter((k) => k !== NONE);
    const entities = await this.prisma.entity.findMany({
      where: { slug: { in: slugs } },
      select: { id: true, slug: true, shortName: true },
    });
    const bySlug = new Map(entities.map((e) => [e.slug, e]));

    const purposeBuckets = buckets(aggs, 'purposes');
    const purposes = await this.prisma.purpose.findMany({
      where: { code: { in: purposeBuckets.map((b) => String(b.key)) } },
      select: { code: true, name: true },
    });
    const purposeName = new Map(purposes.map((p) => [p.code, p.name]));

    return {
      period,
      environment: query.environment,
      totals: totals(result),
      daily: daily(result, period),
      byConsumer: consumerBuckets.map((b) => {
        const entity = bySlug.get(String(b.key));
        return {
          entityId: entity?.id ?? null,
          entityName: entity?.shortName ?? null,
          calls: b.doc_count,
          errors: errorsOf(b),
        };
      }),
      byPurpose: purposeBuckets.map((b) => ({
        code: String(b.key),
        name:
          (purposeName.get(String(b.key)) as string | Record<string, string> | undefined) ?? null,
        calls: b.doc_count,
      })),
      byOperation: buckets(aggs, 'routes').flatMap((route) => {
        const version = routes.get(String(route.key));
        if (!version) return [];
        return buckets(route as Record<string, unknown>, 'operations').map((op) => ({
          ...version,
          // Calls the gateway refused before matching an operation have none.
          operation: op.key === NONE ? '' : String(op.key),
          calls: op.doc_count,
          errors: errorsOf(op),
          latencyP95Ms: percentile(op.latency, 95),
        }));
      }),
      byStatus: buckets(aggs, 'statuses').map((b) => ({
        status: Number(b.key),
        calls: b.doc_count,
      })),
    };
  }
}

function emptyProviderUsage(
  period: UsagePeriod,
  environment: UsageQuery['environment'],
): ProviderUsage {
  return {
    period,
    environment,
    totals: emptyTotals(),
    daily: daily({}, period),
    byConsumer: [],
    byPurpose: [],
    byOperation: [],
    byStatus: [],
  };
}
