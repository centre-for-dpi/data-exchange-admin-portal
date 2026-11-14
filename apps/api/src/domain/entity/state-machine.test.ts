import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../common/errors.js';
import { assertTransition, canTransition } from './state-machine.js';

describe('entity state machine (SPEC.md §4.1)', () => {
  it('lets the applicant submit and the operator decide', () => {
    expect(canTransition('requested', 'under_review')).toBe(true);
    expect(canTransition('under_review', 'active')).toBe(true);
    expect(canTransition('under_review', 'rejected')).toBe(true);
    expect(canTransition('under_review', 'requested')).toBe(true);
  });

  it('never activates a request the operator has not reviewed', () => {
    expect(canTransition('requested', 'active')).toBe(false);
    expect(canTransition('requested', 'rejected')).toBe(false);
  });

  it('keeps rejection final', () => {
    for (const to of ['requested', 'under_review', 'active'] as const) {
      expect(() => assertTransition('rejected', to)).toThrow(InvalidTransitionError);
    }
  });

  it('suspends and reactivates only active entities', () => {
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('suspended', 'active')).toBe(true);
    expect(canTransition('under_review', 'suspended')).toBe(false);
    expect(canTransition('offboarded', 'active')).toBe(false);
    expect(canTransition('suspended', 'offboarded')).toBe(true);
    expect(canTransition('active', 'offboarded')).toBe(true);
  });
});
