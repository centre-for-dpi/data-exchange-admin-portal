import { beforeAll, describe, expect, it } from 'vitest';
import { anchorOverdueSeconds } from './anchor-lag.js';

/** A stand-in for the two tables the lag reads. */
function fake(options: { anchorSeq?: bigint; nextEvent?: Date }) {
  return {
    auditAnchor: {
      findFirst: () =>
        Promise.resolve(options.anchorSeq === undefined ? null : { lastSeq: options.anchorSeq }),
    },
    auditEvent: {
      findFirst: () =>
        Promise.resolve(options.nextEvent ? { occurredAt: options.nextEvent } : null),
    },
  } as unknown as Parameters<typeof anchorOverdueSeconds>[0];
}

describe('anchor overdue seconds (B-02)', () => {
  beforeAll(() => {
    process.env.DEN_COUNTRY ??= 'co';
  });

  it('is 0 when every chained event is anchored', async () => {
    expect(await anchorOverdueSeconds(fake({ anchorSeq: 5n }))).toBe(0);
  });

  it('is 0 while the day of the next event is not over', async () => {
    const now = new Date();
    expect(await anchorOverdueSeconds(fake({ nextEvent: now }), now)).toBe(0);
  });

  it("grows from the end of the unanchored event's day", async () => {
    const event = new Date(Date.now() - 3 * 86_400_000);
    const lag = await anchorOverdueSeconds(fake({ anchorSeq: 1n, nextEvent: event }));
    expect(lag).toBeGreaterThan(1.9 * 86_400);
    expect(lag).toBeLessThan(3 * 86_400);
  });
});
