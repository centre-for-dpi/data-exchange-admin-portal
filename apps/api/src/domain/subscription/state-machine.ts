import type { SubscriptionStatus } from '@den/contracts';
import { InvalidTransitionError } from '../../common/errors.js';

/**
 * Lifecycle of a subscription (SPEC.md §4.4):
 *
 *   pending_provider -> [pending_regulator] -> approved -> active
 *        \-> rejected          \-> rejected
 *   active <-> suspended, active -> revoked, active -> expired
 *   pending_* -> withdrawn (the requester gives up)
 *   pending_provider -> info_requested -> pending_provider (the steward asks, the requester answers)
 *   approved | active | suspended -> expired (validUntil passed, M2-06)
 */
const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  pending_provider: ['pending_regulator', 'approved', 'rejected', 'withdrawn', 'info_requested'],
  info_requested: ['pending_provider', 'withdrawn'],
  pending_regulator: ['approved', 'rejected', 'withdrawn'],
  approved: ['active', 'revoked', 'expired'],
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
  'info_requested',
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
