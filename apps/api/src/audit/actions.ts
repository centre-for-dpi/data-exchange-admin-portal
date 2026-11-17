/**
 * Every action the portal records in the audit trail (M2-09: "todos los eventos del dominio").
 * actions.test.ts checks that each action literal in the code is listed here, that the dynamic
 * ones (`entity.${decision}`, `subscription.${to}`) are covered by their expansions, and that each
 * has a label in both languages of the web, so the timeline never shows a raw code.
 */
export const AUDIT_ACTIONS = [
  // Session and people
  'user.registered',
  'user.created',
  'platform_role.granted',
  'notification_preference.updated',
  // Entities and members (M2-01, M2-02)
  'entity.created',
  'entity.requested',
  'entity.request_updated',
  'entity.submitted',
  'entity.approved',
  'entity.changes_requested',
  'entity.rejected',
  'entity.suspended',
  'entity.reactivated',
  'entity.offboarded',
  'entity.xroad_member_set',
  'membership.created',
  'membership.updated',
  'membership.roles_changed',
  'membership.revoked',
  'invitation.created',
  'invitation.accepted',
  'invitation.declined',
  'invitation.revoked',
  'invitation.expired',
  // Documents (M2-01, M2-07)
  'document.uploaded',
  'document.purged',
  // Catalogue of purposes
  'purpose.created',
  'purpose.updated',
  'purpose.deactivated',
  'purpose.activated',
  // APIs and versions (M1, M2-04, M2-05)
  'api.created',
  'api_version.created',
  'api_version.openapi_replaced',
  'api_version.purposes_changed',
  'api_version.submitted',
  'api_version.approved',
  'api_version.changes_requested',
  'api_version.approved_regulator',
  'api_version.published',
  'api_version.revised',
  'api_version.deprecated',
  'api_version.retired',
  'api_version.validated',
  'api_version.validation_requested',
  // Applications and credentials
  'application.created',
  'credential.created',
  'credential.expiry_notice_queued',
  'credential.expired',
  'credential.rotation_started',
  'credential.rotation_ended',
  'credential.revoked',
  // The operator's mass revocation of client certificates (M6-07)
  'certificate_revocation.executed',
  // Signing keys of the gateway's assertions to providers (M6-10)
  'gateway_signing_key.created',
  // Rotation of RID_SECRETS_KEY: everything sealed again with the new key
  'secrets.resealed',
  // Certificates of the gateway itself (M3-02)
  'gateway_certificate.issued',
  // Subscriptions (M1, M2-04, M2-06, M2-07)
  'subscription.requested',
  'subscription.renewal_requested',
  'subscription.info_requested',
  'subscription.info_provided',
  'subscription.withdrawn',
  'subscription.approved',
  'subscription.approved_regulator',
  'subscription.rejected',
  'subscription.rejected_regulator',
  'subscription.activated',
  'subscription.suspended',
  'subscription.reactivated',
  'subscription.revoked',
  'subscription.expired',
  'subscription.renewal_notice_queued',
  'subscription.agreement_attached',
  // Bootcamp readiness (M4-07)
  'bootcamp.item_updated',
  // Sync console (M5-07): the operator queued a reconcile by hand.
  'sync.retry_requested',
  // Nodes of the kit (M4)
  'node.created',
  'node.enrollment_token_issued',
  'node.enrollment_token_revoked',
  'node.enrolled',
  'node.online',
  'node.offline',
  'node.services_changed',
  'node.certificate_renewed',
  'node.decommissioned',
  // Transparency for the data subject (MT)
  'subject_access.purged',
  'subject_alert.updated',
  'transparency.checkpoint',
  // The audit trail itself (M2-09)
  'audit.anchored',
  'audit.exported',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Expansions of the actions built from a variable. */
export const DYNAMIC_ACTIONS: Record<string, readonly AuditAction[]> = {
  'entity.${decision}': ['entity.approved', 'entity.changes_requested', 'entity.rejected'],
  'subscription.${to}': ['subscription.rejected', 'subscription.revoked', 'subscription.withdrawn'],
};
