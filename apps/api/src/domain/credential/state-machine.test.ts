import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../common/errors.js';
import { assertTransition, canTransition } from './state-machine.js';

describe('credential state machine', () => {
  it('lets an active credential rotate, be revoked or expire', () => {
    expect(canTransition('active', 'rotating')).toBe(true);
    expect(canTransition('active', 'revoked')).toBe(true);
    expect(canTransition('active', 'expired')).toBe(true);
    expect(canTransition('rotating', 'expired')).toBe(true);
  });

  it('keeps revoked and expired final', () => {
    expect(() => assertTransition('expired', 'active')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('revoked', 'active')).toThrow(InvalidTransitionError);
    expect(canTransition('rotating', 'active')).toBe(false);
  });
});
