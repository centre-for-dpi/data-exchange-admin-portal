import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { OPA_SYNC_TARGET } from '../opa/opa.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PGBOSS_SCHEMA } from '../queue/queue.service.js';

/** Where Prometheus scrapes the API, outside /api/v1 (the public prefix). */
export const METRICS_PATH = '/metrics';

/**
 * Bearer token Prometheus presents (DEN_METRICS_TOKEN). Without it the endpoint answers 404:
 * metrics are internal operating data, never public.
 */
export function metricsTokenMatches(authorization: string | undefined): boolean {
  const token = process.env.DEN_METRICS_TOKEN;
  if (!token || !authorization?.startsWith('Bearer ')) return false;
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(authorization.slice('Bearer '.length)), digest(token));
}

/**
 * The API's Prometheus metrics (ARCHITECTURE.md §9, M5-06): request latency per endpoint, and,
 * read from PostgreSQL at each scrape, the background queue, the reconcilers' sync state, how far
 * OPA's bundle is behind, the nodes and the soonest certificate expiry. Labels are route
 * templates, states and kinds: never ids, never personal data.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();
  private readonly http: Histogram<'method' | 'route' | 'status'>;

  constructor(private readonly prisma: PrismaService) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry, prefix: 'den_api_' });
    this.http = new Histogram({
      name: 'den_api_http_request_duration_seconds',
      help: 'Duration of the API requests, by method, route template and status.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    });
    const safely = (name: string, fn: () => Promise<void>) => async () => {
      try {
        await fn();
      } catch (error) {
        this.logger.warn(`Metric ${name} not collected: ${String(error)}`);
      }
    };

    const queue = new Gauge({
      name: 'den_queue_jobs',
      help: 'Background jobs (pg-boss) waiting, retrying, running or failed, by queue.',
      labelNames: ['queue', 'state'],
      registers,
      collect: safely('den_queue_jobs', async () => {
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{ name: string; state: string; count: bigint }>
        >(
          `SELECT name, state::text AS state, count(*) AS count FROM "${PGBOSS_SCHEMA}".job
           WHERE state IN ('created', 'retry', 'active', 'failed') GROUP BY name, state`,
        );
        queue.reset();
        for (const r of rows) queue.set({ queue: r.name, state: r.state }, Number(r.count));
      }),
    });

    const sync = new Gauge({
      name: 'den_sync_targets',
      help: 'Objects the reconcilers keep (sync_state), by system and status.',
      labelNames: ['system', 'status'],
      registers,
      collect: safely('den_sync_targets', async () => {
        const rows = await this.prisma.syncState.groupBy({
          by: ['system', 'status'],
          _count: { _all: true },
        });
        sync.reset();
        for (const r of rows) sync.set({ system: r.system, status: r.status }, r._count._all);
      }),
    });

    const lag = new Gauge({
      name: 'den_opa_bundle_lag_seconds',
      help: 'Seconds since the bundle OPA should run was built, while OPA still runs an older one; 0 when it is current.',
      registers,
      collect: safely('den_opa_bundle_lag_seconds', async () => {
        const state = await this.prisma.syncState.findUnique({
          where: { target: OPA_SYNC_TARGET },
        });
        if (!state || state.appliedHash === state.desiredHash) {
          lag.set(0);
          return;
        }
        const desired = await this.prisma.policyBundle.findUnique({
          where: { revision: state.desiredHash },
          select: { createdAt: true },
        });
        lag.set(desired ? Math.max(0, (Date.now() - desired.createdAt.getTime()) / 1000) : 0);
      }),
    });

    const nodes = new Gauge({
      name: 'den_nodes',
      help: 'Nodes of the kit, by status.',
      labelNames: ['status'],
      registers,
      collect: safely('den_nodes', async () => {
        const rows = await this.prisma.node.groupBy({ by: ['status'], _count: { _all: true } });
        nodes.reset();
        for (const r of rows) nodes.set({ status: r.status }, r._count._all);
      }),
    });

    const expiry = new Gauge({
      name: 'den_certificate_soonest_expiry_seconds',
      help: 'Seconds until the soonest certificate in use expires, by kind (gateway, node, application).',
      labelNames: ['kind'],
      registers,
      collect: safely('den_certificate_soonest_expiry_seconds', async () => {
        const now = Date.now();
        const [gateway, node, application] = await Promise.all([
          // The gateway's current certificate of each purpose: the newest one.
          this.prisma.gatewayCertificate.groupBy({ by: ['purpose'], _max: { notAfter: true } }),
          this.prisma.node.aggregate({
            where: { status: { in: ['enrolled', 'online', 'offline'] } },
            _min: { certificateNotAfter: true },
          }),
          this.prisma.credential.aggregate({
            where: { kind: 'mtls_certificate', status: 'active' },
            _min: { notAfter: true },
          }),
        ]);
        expiry.reset();
        const set = (kind: string, at: Date | null | undefined) => {
          if (at) expiry.set({ kind }, Math.round((at.getTime() - now) / 1000));
        };
        const soonestGateway = gateway
          .map((g) => g._max.notAfter)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime())[0];
        set('gateway', soonestGateway);
        set('node', node._min.certificateNotAfter);
        set('application', application._min.notAfter);
      }),
    });
  }

  /** One API request, by its route template (unmatched paths share one label). */
  observe(method: string, route: string | undefined, status: number, seconds: number): void {
    this.http.observe({ method, route: route ?? 'unmatched', status: String(status) }, seconds);
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
