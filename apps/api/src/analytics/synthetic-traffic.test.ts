import { describe, expect, it } from 'vitest';
import { generateTraffic, SYNTHETIC_NODE, type TrafficSubscription } from './synthetic-traffic.js';

const ALLOWED = new Set([
  'ts',
  'request_id',
  'route_id',
  'operation',
  'method',
  'status',
  'latency_ms',
  'upstream_latency_ms',
  'consumer_entity',
  'consumer_app',
  'subscription_id',
  'purpose',
  'end_user_hash',
  'bytes_sent',
  'gateway_node',
  'deny_reason',
]);

const subscription: TrafficSubscription = {
  subscriptionId: '0190d0c4-0000-7000-8000-00000000c101',
  versionId: '0190d0c4-0000-7000-8000-00000000c102',
  consumerEntity: 'programas-sociales',
  consumerApp: 'den-app-0190d0c4-0000-7000-8000-00000000c103',
  purpose: 'eligibility_check',
  operations: [{ id: 'getAfiliado', method: 'GET' }],
  dailyCalls: 200,
  startDay: 0,
};

// March 2026: the 2nd is a Monday, the 7th and 8th a weekend.
const options = { from: '2026-03-02', days: 7, timeZone: 'America/Bogota', scale: 1, seed: 7 };

describe('synthetic traffic (closing of M5)', () => {
  const docs = [...generateTraffic([subscription], options)];

  it('is the same month for the same seed', () => {
    const again = [...generateTraffic([subscription], options)];
    expect(again).toEqual(docs);
    const other = [...generateTraffic([subscription], { ...options, seed: 8 })];
    expect(other).not.toEqual(docs);
  });

  it('has the shape of the access log: allowlisted fields, the period, a synthetic node', () => {
    for (const doc of docs) {
      expect(Object.keys(doc).filter((k) => !ALLOWED.has(k))).toEqual([]);
      expect(doc.gateway_node).toBe(SYNTHETIC_NODE);
      // Within the week, in Bogotá (UTC−5).
      expect(doc.ts >= '2026-03-02T05:00:00.000Z' && doc.ts < '2026-03-09T05:00:00.000Z').toBe(
        true,
      );
      expect(doc.route_id).toBe(`den-route-${subscription.versionId}`);
    }
  });

  it('mostly succeeds, with refusals that carry their reason and errors from the provider', () => {
    const ok = docs.filter((d) => d.status === 200).length;
    expect(ok / docs.length).toBeGreaterThan(0.9);
    const denied = docs.filter((d) => d.deny_reason);
    expect(denied.length).toBeGreaterThan(0);
    for (const d of denied) expect([403, 429]).toContain(d.status);
    const fromProvider = docs.filter((d) => d.status >= 500);
    for (const d of fromProvider) expect(d.upstream_latency_ms).toBeGreaterThan(0);
    // An invalid token names nobody.
    for (const d of docs.filter((x) => x.status === 401)) expect(d.consumer_app).toBeUndefined();
  });

  it('follows working days and office hours', () => {
    const byDay = (day: string) => docs.filter((d) => d.ts.startsWith(day)).length;
    // Monday against Sunday (UTC days are close enough to Bogotá's at office hours).
    expect(byDay('2026-03-02')).toBeGreaterThan(byDay('2026-03-08') * 3);
    const hourOf = (d: { ts: string }) => (new Date(d.ts).getUTCHours() + 24 - 5) % 24;
    const office = docs.filter((d) => hourOf(d) >= 8 && hourOf(d) < 18).length;
    expect(office / docs.length).toBeGreaterThan(0.75);
  });

  it('never carries a data subject or an official in clear', () => {
    const text = JSON.stringify(docs);
    expect(text).not.toContain('subject');
    for (const d of docs.filter((x) => x.end_user_hash)) {
      expect(d.end_user_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
