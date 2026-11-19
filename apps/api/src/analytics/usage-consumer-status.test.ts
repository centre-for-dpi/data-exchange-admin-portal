import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { routeId } from '../reconcilers/apisix/desired-state.js';
import type { OpenSearch } from './opensearch.js';
import { UsageService } from './usage.service.js';

vi.mock('@den/config', () => ({
  getCountryConfig: () => ({ country: { timezone: 'America/Bogota' } }),
}));

/**
 * The provider's usage (and the regulator's exchange map, same lookup in
 * indicators.service.ts) name the consumer of a call by looking its SLUG up in `entity` without a
 * status filter. Slugs are unique only among submitted/active entities (partial index
 * entity_slug_live): an onboarding draft (`requested`) or a rejected request keeps any slug. A row
 * of that kind with the slug of a real consumer can be the one shown.
 */
describe('consumer names in usage analytics are resolved by a non-unique slug', () => {
  const providerId = '018f0000-0000-7000-8000-000000000001';
  const apiId = '018f0000-0000-7000-8000-000000000002';
  const versionId = '018f0000-0000-7000-8000-000000000003';
  const real = {
    id: '018f0000-0000-7000-8000-00000000aaaa',
    slug: 'dian',
    shortName: 'DIAN',
    status: 'active',
  };
  const draft = {
    id: '018f0000-0000-7000-8000-00000000bbbb',
    slug: 'dian',
    shortName: 'Entidad inventada',
    status: 'requested',
  };

  it('asks for the consumer among entities that can hold the slug (active ones)', async () => {
    // Both rows share the slug; the mock honours the status filter as PostgreSQL would.
    const entityFindMany = vi.fn((args: { where: { status?: { notIn?: string[] } } }) =>
      Promise.resolve(
        [real, draft].filter((e) => !(args.where.status?.notIn ?? []).includes(e.status)),
      ),
    );
    const prisma = {
      api: { findMany: () => Promise.resolve([{ id: apiId, name: 'Afiliación' }]) },
      apiVersion: {
        findMany: () => Promise.resolve([{ id: versionId, version: '1.0', apiId }]),
      },
      entity: { findMany: entityFindMany },
      purpose: { findMany: () => Promise.resolve([]) },
    } as unknown as PrismaService;
    const openSearch: OpenSearch = {
      request: <T>() =>
        Promise.resolve({
          status: 200,
          body: {
            hits: { total: { value: 10 } },
            aggregations: {
              consumers: { buckets: [{ key: 'dian', doc_count: 10, errors: { doc_count: 0 } }] },
              routes: { buckets: [{ key: routeId(versionId), doc_count: 10 }] },
            },
          } as T,
        }),
    };
    const usage = await new UsageService(prisma, openSearch).provided(providerId, {
      environment: 'production',
    });

    // The query must not match drafts or rejected requests...
    const where = entityFindMany.mock.calls[0]?.[0].where ?? {};
    expect(where).toHaveProperty('status');
    // ...so that the consumer shown is the real entity.
    expect(usage.byConsumer[0]).toMatchObject({ entityId: real.id, entityName: 'DIAN' });
  });
});
