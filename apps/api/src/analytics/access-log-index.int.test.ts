import { randomUUID } from 'node:crypto';
import { getCountryConfig } from '@rid/config';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ACCESS_LOG_POLICY,
  ACCESS_LOG_TEMPLATE,
  AccessLogIndexReconciler,
  policyTarget,
  templateTarget,
} from './access-log-index.js';
import { HttpOpenSearch, openSearchUrl } from './opensearch.js';

/**
 * The access-log index template and retention policy (M5-01), against the real OpenSearch of the
 * observability profile (pnpm infra:up).
 */
describe('access-log index template and retention in OpenSearch (M5-01)', () => {
  const prisma = new PrismaService();
  const openSearch = new HttpOpenSearch(openSearchUrl());
  const reconciler = new AccessLogIndexReconciler(prisma, openSearch);
  const index = `rid-access-test-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await openSearch.request('DELETE', `/${index}`);
    await prisma.$disconnect();
  });

  it('installs the template once, then finds it unchanged', async () => {
    await openSearch.request('DELETE', `/_index_template/${ACCESS_LOG_TEMPLATE}`);
    expect(await reconciler.reconcileTemplate()).toBe('created');
    expect(await reconciler.reconcileTemplate()).toBe('unchanged');
    expect(await prisma.syncState.findUnique({ where: { target: templateTarget } })).toMatchObject({
      system: 'opensearch',
      status: 'in_sync',
      lastError: null,
    });
  });

  it('types the fields, and rejects a document with a field outside the allowlist', async () => {
    await reconciler.reconcileTemplate();
    const ok = await openSearch.request('POST', `/${index}/_doc?refresh=true`, {
      ts: '2026-11-16T01:02:08+00:00',
      route_id: 'rid-route-x',
      status: 200,
      latency_ms: 12.5,
      consumer_entity: 'programas-sociales',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const mapping = await openSearch.request<
      Record<
        string,
        { mappings: { dynamic: string; properties: Record<string, { type: string }> } }
      >
    >('GET', `/${index}/_mapping`);
    const properties = mapping.body[index]?.mappings.properties ?? {};
    expect(mapping.body[index]?.mappings.dynamic).toBe('strict');
    expect(properties.status?.type).toBe('short');
    expect(properties.ts?.type).toBe('date');
    expect(properties.consumer_entity?.type).toBe('keyword');

    // Third barrier: a path that got past APISIX and Fluent Bit would still not be indexed.
    const rejected = await openSearch.request('POST', `/${index}/_doc`, {
      ts: '2026-11-16T01:02:08+00:00',
      uri: '/salud/afiliados/1000000001?documento=1000000001',
    });
    expect(rejected.status).toBe(400);
  });

  it('keeps the logs for the configured months, then deletes them', async () => {
    await openSearch.request('DELETE', `/_plugins/_ism/policies/${ACCESS_LOG_POLICY}`);
    expect(await reconciler.reconcilePolicy()).toBe('created');
    expect(await reconciler.reconcilePolicy()).toBe('unchanged');
    const months = getCountryConfig().retention.accessLogMonths;
    const policy = await openSearch.request<{
      policy: {
        description: string;
        states: Array<{
          name: string;
          transitions: Array<{ conditions: { min_index_age: string } }>;
        }>;
        ism_template: Array<{ index_patterns: string[] }>;
      };
    }>('GET', `/_plugins/_ism/policies/${ACCESS_LOG_POLICY}`);
    expect(policy.body.policy.description).toContain(`kept ${months} months`);
    expect(policy.body.policy.states[0]?.transitions[0]?.conditions.min_index_age).toBe(
      `${(months + 1) * 31}d`,
    );
    expect(policy.body.policy.ism_template[0]?.index_patterns).toEqual(['rid-access-*']);
    expect(await prisma.syncState.findUnique({ where: { target: policyTarget } })).toMatchObject({
      status: 'in_sync',
    });
  });

  it('records an unreachable OpenSearch as an error in sync_state', async () => {
    const down = new AccessLogIndexReconciler(
      prisma,
      new HttpOpenSearch('http://127.0.0.1:1', undefined, 500),
    );
    await expect(down.reconcileTemplate()).rejects.toThrow();
    expect(await prisma.syncState.findUnique({ where: { target: templateTarget } })).toMatchObject({
      status: 'error',
    });
    await reconciler.reconcileTemplate();
  });
});
