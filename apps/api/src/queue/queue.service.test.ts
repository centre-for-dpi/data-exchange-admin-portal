import { describe, expect, it } from 'vitest';
import { outboxRetentionDays } from './queue.service.js';

describe('outbox retention (B-14)', () => {
  it('keeps relayed rows 7 days unless DEN_OUTBOX_RETENTION_DAYS says otherwise', () => {
    expect(outboxRetentionDays(undefined)).toBe(7);
    expect(outboxRetentionDays('')).toBe(7);
    expect(outboxRetentionDays('30')).toBe(30);
  });

  it('refuses a value that is not a whole number of days', () => {
    for (const bad of ['0', '-1', '1.5', 'siete', '7d']) {
      expect(() => outboxRetentionDays(bad)).toThrow(/DEN_OUTBOX_RETENTION_DAYS/);
    }
  });
});
