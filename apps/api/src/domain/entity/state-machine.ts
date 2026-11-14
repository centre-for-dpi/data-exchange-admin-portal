import type { EntityStatus } from '@rid/contracts';
import { InvalidTransitionError } from '../../common/errors.js';

/**
 * Lifecycle of an entity (SPEC.md §4.1):
 *
 *   requested -> under_review -> active
 *       ^            |    \-> rejected
 *       \------------/  (the reviewer asks for corrections)
 *   active <-> suspended, active -> offboarded
 *
 * `requested` is the applicant's turn (edit, attach the designation, submit); `under_review` is
 * the operator's. Suspension and offboarding are not implemented yet (M2-11).
 */
const TRANSITIONS: Record<EntityStatus, readonly EntityStatus[]> = {
  requested: ['under_review'],
  under_review: ['requested', 'active', 'rejected'],
  active: ['suspended', 'offboarded'],
  suspended: ['active'],
  rejected: [],
  offboarded: [],
};

/** Statuses of an onboarding request that is still open. */
export const OPEN_REQUEST_STATUSES: readonly EntityStatus[] = ['requested', 'under_review'];

export function canTransition(from: EntityStatus, to: EntityStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidTransitionError (409) when the transition is not allowed. */
export function assertTransition(from: EntityStatus, to: EntityStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError('entity', from, to);
}
