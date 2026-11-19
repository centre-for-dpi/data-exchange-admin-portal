import { describe, expect, it, vi } from 'vitest';
import { VersionLifecycleService } from './version-lifecycle.service.js';

describe('retiring a version', () => {
  it('closes every live request of the version, info_requested included', async () => {
    let subscriptionWhere: { status?: { in?: string[] } } | undefined;
    const tx = {
      apiVersion: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'v1',
          apiId: 'a1',
          status: 'deprecated',
          sunsetAt: new Date(0),
          deprecatedBy: 'u1',
          createdBy: 'u1',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      subscription: {
        findMany: vi.fn((args: { where: typeof subscriptionWhere }) => {
          subscriptionWhere = args.where;
          return Promise.resolve([]);
        }),
      },
    };
    const prisma = {
      apiVersion: { findMany: vi.fn().mockResolvedValue([{ id: 'v1' }]) },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new VersionLifecycleService(
      prisma as never,
      { record: vi.fn().mockResolvedValue(1n) },
      { enqueue: vi.fn().mockResolvedValue(undefined) },
      { refreshApiStatus: vi.fn().mockResolvedValue(undefined) } as never,
    );
    expect(await service.retireDue(new Date())).toEqual(['v1']);
    // A request in info_requested must not survive the retirement (M-07).
    expect(subscriptionWhere?.status?.in).toContain('info_requested');
  });
});
