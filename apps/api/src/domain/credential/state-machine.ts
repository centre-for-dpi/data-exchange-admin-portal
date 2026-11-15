import { InvalidTransitionError } from '../../common/errors.js';

export type CredentialStatus = 'active' | 'rotating' | 'revoked' | 'expired';

/**
 * Lifecycle of a credential (SPEC.md §3, §4.3):
 *
 *   active -> rotating (a newer credential took over, M3-04) -> revoked | expired
 *   active -> revoked | expired
 *
 * `expired` applies to certificates past notAfter. `revoked` and `expired` are final.
 */
const TRANSITIONS: Record<CredentialStatus, readonly CredentialStatus[]> = {
  active: ['rotating', 'revoked', 'expired'],
  rotating: ['revoked', 'expired'],
  revoked: [],
  expired: [],
};

/** Statuses of a credential that still authenticates its application. */
export const USABLE_CREDENTIAL_STATUSES: readonly CredentialStatus[] = ['active', 'rotating'];

export function canTransition(from: CredentialStatus, to: CredentialStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidTransitionError (409) when the transition is not allowed. */
export function assertTransition(from: CredentialStatus, to: CredentialStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError('credential', from, to);
}
