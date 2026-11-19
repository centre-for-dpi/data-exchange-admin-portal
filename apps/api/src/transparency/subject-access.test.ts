import { describe, expect, it } from 'vitest';
import { MetricsService } from '../metrics/metrics.service.js';
import { gatewayRecordSchema, SubjectAccessService } from './subject-access.service.js';

const hex = (n: number) => 'ab'.repeat(n);
const record = (overrides: Record<string, unknown> = {}) => ({
  ts: '1794000000.123',
  gateway_node: 'apisix-1',
  gateway_request_id: hex(16),
  route_id: 'den-route-0193a6c0-0000-7000-8000-000000000001',
  operation: 'getAfiliado',
  subscription_id: '0193a6c0-0000-7000-8000-000000000002',
  end_user_hash: hex(32),
  subject_ref: hex(32),
  status: '200',
  upstream_status: '200',
  ...overrides,
});

/**
 * The consumer's X-Request-Id and the transparency register (A-4, M-16): a field the consumer
 * chooses, and not part of the evidence, must never make the collector drop the record of an
 * authorized call, nor be kept next to the pseudonym.
 */
describe('collector of the transparency register: the consumer-chosen X-Request-Id', () => {
  it('accepts the record of an authorized call', () => {
    expect(gatewayRecordSchema.safeParse(record()).success).toBe(true);
  });

  it('a long X-Request-Id from a gateway on the old log format does not make it invalid', () => {
    // APISIX's request-id plugin keeps a client-sent value; before R-03 the log format carried
    // it as request_id, and 201 characters made the record invalid.
    const parsed = gatewayRecordSchema.safeParse(record({ request_id: 'a'.repeat(201) }));
    expect(parsed.success).toBe(true);
    // Stripped, never stored: it is free text next to the pseudonym.
    expect(parsed.data).not.toHaveProperty('request_id');
  });

  it('the collector does not drop that call as invalid', async () => {
    const prisma = { subscription: { findMany: () => Promise.resolve([]) } };
    const metrics = new MetricsService({} as never);
    const service = new SubjectAccessService(prisma as never, {} as never, {} as never, metrics);
    const result = await service.ingest([
      record({ request_id: 'a'.repeat(201) }),
      record({ request_id: 'CC-1032456789' }),
    ]);
    // Unknown here only because of the stub: the point is that both get that far.
    expect(result.dropped.invalid ?? 0).toBe(0);
    expect(result.dropped.unknown_subscription).toBe(2);
  });
});

describe('collector of the transparency register: what it drops is counted (A-3, A-4)', () => {
  it('counts each dropped record by reason on /metrics, every reason from zero', async () => {
    const prisma = { subscription: { findMany: () => Promise.resolve([]) } };
    const metrics = new MetricsService({} as never);
    const service = new SubjectAccessService(prisma as never, {} as never, {} as never, metrics);
    await service.ingest([record({ subject_ref: '1000000001' }), 'not a record', record()]);
    const text = await metrics.registry.getSingleMetricAsString(
      'den_transparency_records_dropped_total',
    );
    expect(text).toContain('den_transparency_records_dropped_total{reason="invalid"} 2');
    expect(text).toContain(
      'den_transparency_records_dropped_total{reason="unknown_subscription"} 1',
    );
    expect(text).toContain('den_transparency_records_dropped_total{reason="route_mismatch"} 0');
    // Counts and reasons only, never a value of the records.
    expect(text).not.toContain('1000000001');
  });
});
