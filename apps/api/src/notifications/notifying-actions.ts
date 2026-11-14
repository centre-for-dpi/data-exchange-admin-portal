/** Outbox topic of the notification dispatcher (M2-08). */
export const NOTIFICATION_TOPIC = 'notification.dispatch';

/**
 * Audit actions that notify someone (SPEC.md §7). AuditService queues them in the same
 * transaction as the event, so a notification exists if and only if the change committed.
 */
export const NOTIFYING_ACTIONS: ReadonlySet<string> = new Set([
  'invitation.created',
  'entity.approved',
  'entity.rejected',
  'entity.changes_requested',
  'entity.suspended',
  'entity.reactivated',
  'entity.offboarded',
  'api_version.submitted',
  'api_version.approved',
  'api_version.changes_requested',
  'api_version.published',
  'api_version.deprecated',
  'subscription.requested',
  'subscription.renewal_requested',
  'subscription.info_provided',
  'subscription.info_requested',
  'subscription.approved',
  'subscription.approved_regulator',
  'subscription.rejected',
  'subscription.rejected_regulator',
  'subscription.suspended',
  'subscription.revoked',
  'subscription.renewal_notice_queued',
]);
