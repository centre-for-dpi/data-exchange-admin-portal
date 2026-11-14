import { API_VERSION_STATUSES } from '@rid/contracts';
import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../common/errors.js';
import { assertTransition, canTransition, isEditable } from './state-machine.js';

describe('API version state machine (SPEC.md §4.2)', () => {
  it.each([
    ['draft', 'in_review'],
    ['in_review', 'changes_requested'],
    ['in_review', 'approved_operator'],
    ['changes_requested', 'in_review'],
    ['changes_requested', 'draft'],
    ['approved_operator', 'approved_regulator'],
    ['approved_operator', 'published'],
    ['approved_operator', 'changes_requested'],
    ['approved_regulator', 'published'],
    ['published', 'deprecated'],
    ['deprecated', 'retired'],
    ['published', 'retired'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['draft', 'published'],
    ['draft', 'approved_operator'],
    ['in_review', 'published'],
    ['published', 'draft'],
    ['retired', 'published'],
    ['deprecated', 'published'],
    ['approved_regulator', 'changes_requested'],
  ] as const)('rejects %s -> %s with InvalidTransitionError', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('has no way out of retired', () => {
    expect(API_VERSION_STATUSES.filter((to) => canTransition('retired', to))).toEqual([]);
  });

  it('lets the provider edit only drafts and versions with requested changes', () => {
    expect(API_VERSION_STATUSES.filter(isEditable)).toEqual(['draft', 'changes_requested']);
  });
});
