import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../common/errors.js';
import { assertTransition, canTransition } from './state-machine.js';

describe('node state machine (SPEC.md §4.6)', () => {
  it('follows enrollment_issued -> enrolled -> online <-> offline', () => {
    expect(canTransition('enrollment_issued', 'enrolled')).toBe(true);
    expect(canTransition('enrolled', 'online')).toBe(true);
    expect(canTransition('online', 'offline')).toBe(true);
    expect(canTransition('offline', 'online')).toBe(true);
    // An enrolled node that never sends a heartbeat goes offline too.
    expect(canTransition('enrolled', 'offline')).toBe(true);
  });

  it('cannot skip enrollment or go back to it', () => {
    expect(canTransition('enrollment_issued', 'online')).toBe(false);
    expect(canTransition('online', 'enrolled')).toBe(false);
    expect(canTransition('offline', 'enrollment_issued')).toBe(false);
  });

  it('decommissions from every live state, and decommissioned is final', () => {
    for (const from of ['enrollment_issued', 'enrolled', 'online', 'offline'] as const) {
      expect(canTransition(from, 'decommissioned'), from).toBe(true);
    }
    expect(() => assertTransition('decommissioned', 'online')).toThrow(InvalidTransitionError);
  });
});
