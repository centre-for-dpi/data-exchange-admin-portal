import { InvalidTransitionError } from '../../common/errors.js';

export type NodeStatus = 'enrollment_issued' | 'enrolled' | 'online' | 'offline' | 'decommissioned';

/**
 * Lifecycle of a node of the kit (SPEC.md §4.6):
 *
 *   enrollment_issued -> enrolled -> online <-> offline
 *   any but decommissioned -> decommissioned
 *
 * `enrollment_issued` waits for the kit to enroll with a token; `enrolled` has its certificate and
 * tunnel but has not sent a heartbeat yet. Five minutes without a heartbeat is `offline`.
 * `decommissioned` is final: its certificate and tunnel peer stop working.
 */
const TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  enrollment_issued: ['enrolled', 'decommissioned'],
  enrolled: ['online', 'offline', 'decommissioned'],
  online: ['offline', 'decommissioned'],
  offline: ['online', 'decommissioned'],
  decommissioned: [],
};

/** Statuses of a node that holds a certificate and a tunnel peer. */
export const ENROLLED_NODE_STATUSES: readonly NodeStatus[] = ['enrolled', 'online', 'offline'];

export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidTransitionError (409) when the transition is not allowed. */
export function assertTransition(from: NodeStatus, to: NodeStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError('node', from, to);
}
