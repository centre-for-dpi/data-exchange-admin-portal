import { describe, expect, it } from 'vitest';
import { firstDayToAnchor } from './audit-anchor.service.js';

describe('where an anchoring run starts (M2-09)', () => {
  it('starts at the first event when nothing was anchored yet', () => {
    expect(firstDayToAnchor(undefined, '2026-11-11')).toBe('2026-11-11');
  });

  it('jumps over a long period without events instead of stalling', () => {
    // 100 days without events after the last anchor: the run starts at the next event's day.
    expect(firstDayToAnchor('2026-11-13', '2027-02-21')).toBe('2027-02-21');
  });

  it('never goes back to a day already anchored', () => {
    expect(firstDayToAnchor('2026-11-13', '2026-11-13')).toBe('2026-11-14');
    expect(firstDayToAnchor('2026-11-13', '2026-11-10')).toBe('2026-11-14');
  });
});
