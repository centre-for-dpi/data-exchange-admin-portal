import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../common/errors.js';
import { addMonths } from '../../subscriptions/subscriptions.service.js';
import { assertTransition, canTransition } from './state-machine.js';

describe('subscription state machine (SPEC.md §4.4)', () => {
  it('the provider step leads to approval, the regulator or rejection', () => {
    expect(canTransition('pending_provider', 'approved')).toBe(true);
    expect(canTransition('pending_provider', 'pending_regulator')).toBe(true);
    expect(canTransition('pending_provider', 'rejected')).toBe(true);
    expect(canTransition('pending_regulator', 'approved')).toBe(true);
  });

  it('final states do not move and approval is not reversible into a request', () => {
    for (const from of ['rejected', 'revoked', 'expired', 'withdrawn'] as const) {
      expect(() => assertTransition(from, 'active')).toThrow(InvalidTransitionError);
    }
    expect(canTransition('approved', 'pending_provider')).toBe(false);
    expect(canTransition('approved', 'rejected')).toBe(false);
  });
});

describe('addMonths', () => {
  const at = (iso: string) => new Date(iso);

  it('adds calendar months in UTC', () => {
    expect(addMonths(at('2026-01-15T10:00:00.000Z'), 6).toISOString()).toBe(
      '2026-07-15T10:00:00.000Z',
    );
    expect(addMonths(at('2026-11-30T23:00:00.000Z'), 12).toISOString()).toBe(
      '2027-11-30T23:00:00.000Z',
    );
  });

  it('clamps to the last day of a shorter month', () => {
    expect(addMonths(at('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addMonths(at('2027-08-31T00:00:00.000Z'), 6).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});
