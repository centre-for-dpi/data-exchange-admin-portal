import { createHash } from 'node:crypto';
import { nextDay, startOfLocalDay } from '../common/local-day.js';
import { routeId } from '../reconcilers/apisix/desired-state.js';

/**
 * Synthetic traffic for demos and the closing of M5 (the regulator sees a simulated month's
 * indicators): access-log documents shaped as Fluent Bit leaves them (ARCHITECTURE.md §8), for
 * the network's real active subscriptions. Never real calls, never personal data: the official is
 * a random hash and there is no data subject at all. Deterministic for a given seed.
 */

/** An active subscription as the generator needs it. */
export interface TrafficSubscription {
  subscriptionId: string;
  versionId: string;
  consumerEntity: string;
  consumerApp: string;
  purpose: string;
  operations: Array<{ id: string; method: string }>;
  /** Calls per working day at full scale (the subscription's own size). */
  dailyCalls: number;
  /** Day of the period (0-based) the consumer starts calling: adoption over the month. */
  startDay: number;
}

export interface TrafficOptions {
  /** First local day, YYYY-MM-DD. */
  from: string;
  days: number;
  timeZone: string;
  /** Multiplies every subscription's calls. */
  scale: number;
  seed: number;
}

export interface AccessLogDocument {
  ts: string;
  request_id: string;
  route_id: string;
  operation?: string;
  method: string;
  status: number;
  latency_ms: number;
  upstream_latency_ms?: number;
  consumer_entity?: string;
  consumer_app?: string;
  subscription_id?: string;
  purpose?: string;
  end_user_hash?: string;
  bytes_sent: number;
  gateway_node: string;
  deny_reason?: string;
}

/** The node name of every synthetic record: they can be told apart (and deleted). */
export const SYNTHETIC_NODE = 'synthetic';

/** mulberry32: a small seeded PRNG, so a demo month is the same every time. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Share of a day's calls in each local hour: office hours, a dip at lunch, little at night. */
const HOURS = [
  0.2, 0.1, 0.1, 0.1, 0.1, 0.3, 1, 3, 8, 11, 12, 10, 6, 8, 11, 11, 9, 6, 3, 2, 1, 0.8, 0.5, 0.3,
];
const HOURS_TOTAL = HOURS.reduce((a, b) => a + b, 0);

/** Weekends see a sixth of a working day's calls. */
const WEEKEND_FACTOR = 0.15;

/** What can happen to one call, with its share; the rest is a 2xx. */
const OUTCOMES = [
  { share: 0.012, status: 403, deny: 'purpose_not_allowed' },
  { share: 0.004, status: 403, deny: 'end_user_required' },
  { share: 0.004, status: 429, deny: 'rate_limited' },
  { share: 0.003, status: 401 },
  { share: 0.006, status: 404, upstream: true },
  { share: 0.004, status: 502, upstream: true },
  { share: 0.002, status: 504, upstream: true },
] as const;

const OTHER_PURPOSES = ['benefit_targeting', 'statistics', 'fraud_detection'];

/** A latency in ms around a typical value with a long tail (log-normal). */
function latency(random: () => number, typical: number): number {
  const u = Math.max(random(), 1e-9);
  const v = random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.round(typical * Math.exp(0.45 * normal) * 1000) / 1000;
}

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** Poisson-ish count around a mean (normal approximation, never negative). */
function count(random: () => number, mean: number): number {
  if (mean <= 0) return 0;
  const u = Math.max(random(), 1e-9);
  const v = random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal));
}

/** The documents of the period, oldest first per subscription; yields in chunks. */
export function* generateTraffic(
  subscriptions: TrafficSubscription[],
  options: TrafficOptions,
): Generator<AccessLogDocument> {
  const random = prng(options.seed);
  // A few officials per consumer app: their hashes repeat, as real ones would.
  const officials = (app: string) =>
    Array.from({ length: 6 }, (_, i) => hex(`synthetic-official|${app}|${i}`));
  let day = options.from;
  for (let d = 0; d < options.days; d += 1, day = nextDay(day)) {
    const start = startOfLocalDay(day, options.timeZone).getTime();
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    for (const s of subscriptions) {
      if (d < s.startDay || s.operations.length === 0) continue;
      const people = officials(s.consumerApp);
      const mean = s.dailyCalls * options.scale * (weekend ? WEEKEND_FACTOR : 1);
      const calls = count(random, mean);
      for (let c = 0; c < calls; c += 1) {
        // An hour by the office-hours shape, then a second within it.
        let pick = random() * HOURS_TOTAL;
        let hour = 0;
        while (hour < 23 && pick >= (HOURS[hour] ?? 0)) {
          pick -= HOURS[hour] ?? 0;
          hour += 1;
        }
        const at = start + hour * 3_600_000 + Math.floor(random() * 3_600_000);
        const operation = s.operations[Math.floor(random() * s.operations.length)];
        const roll = random();
        let acc = 0;
        const outcome = OUTCOMES.find((o) => (acc += o.share) > roll);
        const base: AccessLogDocument = {
          ts: new Date(at).toISOString(),
          request_id: hex(`synthetic|${options.seed}|${s.subscriptionId}|${d}|${c}`).slice(0, 32),
          route_id: routeId(s.versionId),
          method: operation?.method ?? 'GET',
          status: 200,
          latency_ms: 0,
          bytes_sent: 280 + Math.floor(random() * 900),
          gateway_node: SYNTHETIC_NODE,
        };
        if (!outcome || 'upstream' in outcome) {
          const upstream = latency(random, outcome?.status === 504 ? 30_000 : 35);
          yield {
            ...base,
            operation: operation?.id,
            status: outcome?.status ?? 200,
            latency_ms: Math.round((upstream + latency(random, 3)) * 1000) / 1000,
            upstream_latency_ms: upstream,
            consumer_entity: s.consumerEntity,
            consumer_app: s.consumerApp,
            subscription_id: s.subscriptionId,
            purpose: s.purpose,
            end_user_hash: people[Math.floor(random() * people.length)],
          };
        } else if (outcome.status === 401) {
          // An invalid token: nobody can be named.
          yield { ...base, status: 401, latency_ms: latency(random, 1.5), bytes_sent: 180 };
        } else {
          yield {
            ...base,
            status: outcome.status,
            latency_ms: latency(random, 2),
            consumer_entity: s.consumerEntity,
            consumer_app: s.consumerApp,
            purpose:
              outcome.deny === 'purpose_not_allowed'
                ? (OTHER_PURPOSES[Math.floor(random() * OTHER_PURPOSES.length)] ?? 'statistics')
                : s.purpose,
            deny_reason: outcome.deny,
            bytes_sent: 420,
          };
        }
      }
    }
  }
}
