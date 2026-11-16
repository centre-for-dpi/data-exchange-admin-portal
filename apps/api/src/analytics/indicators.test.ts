import { describe, expect, it } from 'vitest';
import { median, monthsUpTo } from './indicators.service.js';

describe('indicator helpers (M5-04)', () => {
  it('the median of odd and even counts, null without values', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([1.04, 1.06])).toBe(1.1);
  });

  it('the months ending with one, across a year boundary', () => {
    expect(monthsUpTo('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsUpTo('2026-12', 1)).toEqual(['2026-12']);
  });
});
