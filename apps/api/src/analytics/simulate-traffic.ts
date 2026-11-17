// `pnpm traffic:simulate [--from YYYY-MM-DD] [--days 30] [--scale 1] [--seed 42]`: a simulated
// month of the network's traffic for demos and the closing of M5 (synthetic-traffic.ts). Writes
// access-log documents into den-access-synthetic-YYYY.MM (part of the analytics, deleted apart:
// `--clear`). Development and demo deployments only.
import { parseArgs } from 'node:util';
import { getCountryConfig } from '@den/config';
import { listOperations } from '../apis/lint/openapi-lint.js';
import { localDay } from '../common/local-day.js';
import { loadDevEnv } from '../dev-env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessLogIndexReconciler } from './access-log-index.js';
import { HttpOpenSearch, openSearchUrl } from './opensearch.js';
import {
  type AccessLogDocument,
  generateTraffic,
  prng,
  SYNTHETIC_NODE,
  type TrafficSubscription,
} from './synthetic-traffic.js';
import { addDays } from './usage-query.js';

const INDEX_PREFIX = 'den-access-synthetic-';
const BATCH = 5_000;

async function main(): Promise<void> {
  loadDevEnv();
  if (process.env.NODE_ENV === 'production' && process.env.DEN_ALLOW_SYNTHETIC_TRAFFIC !== 'true') {
    throw new Error('Refusing synthetic traffic in production (DEN_ALLOW_SYNTHETIC_TRAFFIC=true)');
  }
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      days: { type: 'string', default: '30' },
      scale: { type: 'string', default: '1' },
      seed: { type: 'string', default: '42' },
      clear: { type: 'boolean', default: false },
      // A tag of its own (tests): den-access-synthetic-<tag>-YYYY.MM, cleared apart.
      tag: { type: 'string' },
    },
  });
  if (values.tag !== undefined && !/^[a-z0-9]{1,40}$/.test(values.tag)) {
    throw new Error('--tag: 1 to 40 lowercase letters and digits');
  }
  const prefix = values.tag ? `${INDEX_PREFIX}${values.tag}-` : INDEX_PREFIX;
  const openSearch = new HttpOpenSearch(openSearchUrl(), undefined, 60_000);
  if (values.clear) {
    const res = await openSearch.request('DELETE', `/${prefix}*`);
    console.warn(`Synthetic traffic deleted (${res.status}).`);
    return;
  }
  const timeZone = getCountryConfig().country.timezone;
  const days = Number(values.days);
  const scale = Number(values.scale);
  const seed = Number(values.seed);
  if (!Number.isInteger(days) || days < 1 || days > 366 || !(scale > 0) || !Number.isFinite(seed)) {
    throw new Error('--days 1..366, --scale > 0 and a numeric --seed');
  }
  const from = values.from ?? addDays(localDay(new Date(), timeZone), -(days - 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('--from YYYY-MM-DD');

  const prisma = new PrismaService();
  try {
    await new AccessLogIndexReconciler(prisma, openSearch).reconcileTemplate();
    const rows = await prisma.subscription.findMany({
      where: {
        status: 'active',
        application: { environment: 'production' },
        apiVersion: { status: { in: ['published', 'deprecated'] } },
      },
      select: {
        id: true,
        purposeCode: true,
        approvedOperations: true,
        application: { select: { keycloakClientId: true, entity: { select: { slug: true } } } },
        apiVersion: { select: { id: true, openapiSpec: true } },
      },
      orderBy: { id: 'asc' },
    });
    const random = prng(seed + 1);
    const subscriptions: TrafficSubscription[] = rows.map((r) => {
      const all = listOperations(r.apiVersion.openapiSpec as Record<string, unknown>);
      const approved = all.filter(
        (o) => r.approvedOperations.length === 0 || r.approvedOperations.includes(o.operationId),
      );
      return {
        subscriptionId: r.id,
        versionId: r.apiVersion.id,
        consumerEntity: r.application.entity.slug,
        consumerApp: r.application.keycloakClientId,
        purpose: r.purposeCode,
        operations: approved.map((o) => ({ id: o.operationId, method: o.method })),
        // From a few dozen to a few hundred calls a working day (log-uniform).
        dailyCalls: Math.round(20 * 20 ** random()),
        // Adoption: most start in the first days, some during the month.
        startDay: Math.floor(random() ** 2 * Math.min(days - 1, 20)),
      };
    });

    let written = 0;
    let batch: AccessLogDocument[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const body =
        batch
          .flatMap((doc) => [
            JSON.stringify({
              index: { _index: `${prefix}${doc.ts.slice(0, 7).replace('-', '.')}` },
            }),
            JSON.stringify(doc),
          ])
          .join('\n') + '\n';
      const res = await fetch(new URL('/_bulk', openSearchUrl()), {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      const result = (await res.json()) as { errors?: boolean; items?: unknown[] };
      if (!res.ok || result.errors) {
        throw new Error(
          `OpenSearch bulk failed: ${res.status} ${JSON.stringify(result.items?.[0])}`,
        );
      }
      written += batch.length;
      batch = [];
    };
    for (const doc of generateTraffic(subscriptions, { from, days, timeZone, scale, seed })) {
      batch.push(doc);
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    await openSearch.request('POST', `/${prefix}*/_refresh`);
    console.warn(
      `Synthetic traffic: ${written} calls of ${subscriptions.length} active subscriptions, ` +
        `${from} + ${days} days (${timeZone}), node "${SYNTHETIC_NODE}". Remove it with --clear.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
