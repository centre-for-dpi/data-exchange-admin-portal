import { describe, expect, it, vi } from 'vitest';
import { EntityStatusService } from './entity-status.service.js';

describe('POST /admin/entities/:id/reactivate', () => {
  it('refuses an onboarding request still under review (it is not a suspended entity)', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const review = vi.fn().mockResolvedValue({});
    const tx = { entity: { updateMany }, entityReview: { create: review } };
    const prisma = {
      entity: {
        // An onboarding request waiting for the reviewer, filed by anyone (the caller included).
        findUnique: vi.fn().mockResolvedValue({ id: 'e1', status: 'under_review' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      subscription: { groupBy: vi.fn().mockResolvedValue([]) },
      application: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const audit = { record: vi.fn().mockResolvedValue(1n) };
    const service = new EntityStatusService(
      prisma as never,
      audit,
      { enqueue: vi.fn().mockResolvedValue(undefined) },
      {} as never,
    );
    const principal = { userId: 'u-admin', keycloakSub: 'sub-admin' } as never;

    await service.reactivate('e1', principal).catch(() => undefined);

    // The entity state machine allows under_review -> active (that is the approval, with its own
    // checks), so reactivation has to demand `suspended` by itself (M-04).
    expect(updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
