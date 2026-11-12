import type { SubscriptionStatus } from '@rid/contracts';
import { InvalidTransitionError } from '../../common/errors.js';

/**
 * Lifecycle of a subscription (SPEC.md §4.4):
 *
 *   pending_provider -> [pending_regulator] -> approved -> active
 *        \-> rejected          \-> rejected
 *   active <-> suspended, active -> revoked, active -> expired
 *   pending_* -> withdrawn (the requester gives up)
 */
const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  pending_provider: ['pending_regulator', 'approved', 'rejected', 'withdrawn'],
  pending_regulator: ['approved', 'rejected', 'withdrawn'],
  approved: ['active', 'revoked'],
  active: ['suspended', 'revoked', 'expired'],
  suspended: ['active', 'revoked', 'expired'],
  revoked: [],
  expired: [],
  rejected: [],
  withdrawn: [],
};

/** Statuses that hold the "one live subscription per app, version and purpose" slot. */
export const LIVE_STATUSES: readonly SubscriptionStatus[] = [
  'pending_provider',
  'pending_regulator',
  'approved',
  'active',
  'suspended',
];

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidTransitionError (409) when the transition is not allowed. */
export function assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError('subscription', from, to);
}
