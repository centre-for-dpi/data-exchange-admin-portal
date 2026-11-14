import { describe, expect, it } from 'vitest';
import { localDay, nextDay, startOfLocalDay } from './local-day.js';

describe('local days', () => {
  it('names the day of an instant in a time zone', () => {
    // 03:00 UTC is still the previous day five hours behind.
    expect(localDay(new Date('2026-11-14T03:00:00Z'), 'America/Bogota')).toBe('2026-11-13');
    expect(localDay(new Date('2026-11-14T03:00:00Z'), 'UTC')).toBe('2026-11-14');
  });

  it('finds when a local day starts, also across DST', () => {
    expect(startOfLocalDay('2026-11-14', 'America/Bogota').toISOString()).toBe(
      '2026-11-14T05:00:00.000Z',
    );
    expect(startOfLocalDay('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(startOfLocalDay('2026-03-09', 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
    expect(startOfLocalDay('2026-07-01', 'Europe/Madrid').toISOString()).toBe(
      '2026-06-30T22:00:00.000Z',
    );
  });

  it('steps to the next day across month and year ends', () => {
    expect(nextDay('2026-11-30')).toBe('2026-12-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });
});
