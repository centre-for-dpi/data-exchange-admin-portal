import type { ApiVersionStatus } from '@rid/contracts';
import { InvalidTransitionError } from '../../common/errors.js';

/**
 * Lifecycle of an API version (SPEC.md §4.2):
 *
 *   draft -> in_review -> approved_operator -> [approved_regulator] -> published
 *              \-> changes_requested -> draft (or straight back to in_review)
 *   approved_operator -> changes_requested (the regulator sends it back, M2-04)
 *   published -> deprecated -> retired
 */
const TRANSITIONS: Record<ApiVersionStatus, readonly ApiVersionStatus[]> = {
  draft: ['in_review'],
  in_review: ['changes_requested', 'approved_operator'],
  changes_requested: ['draft', 'in_review'],
  approved_operator: ['approved_regulator', 'published', 'changes_requested'],
  approved_regulator: ['published'],
  published: ['deprecated'],
  deprecated: ['retired'],
  retired: [],
};

/** States in which the provider may still edit the version's content. */
export const EDITABLE_STATES: readonly ApiVersionStatus[] = ['draft', 'changes_requested'];

export function canTransition(from: ApiVersionStatus, to: ApiVersionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidTransitionError (409) when the transition is not allowed. */
export function assertTransition(from: ApiVersionStatus, to: ApiVersionStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError('api_version', from, to);
}

export const isEditable = (status: ApiVersionStatus): boolean => EDITABLE_STATES.includes(status);
