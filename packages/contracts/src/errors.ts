import { z } from 'zod';

/** Base URL for RFC 9457 problem `type` values. */
export const PROBLEM_TYPE_BASE = 'https://den.example/errors/';

/**
 * Stable error codes exposed by the portal API. The code is the last path segment
 * of the problem `type` URL. Add new codes here; never rename an existing one.
 */
export const ErrorCode = {
  ValidationFailed: 'validation_failed',
  BadRequest: 'bad_request',
  Unauthenticated: 'unauthenticated',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  /** The resource existed and was removed for good (a document deleted by legal order). */
  Gone: 'gone',
  InvalidTransition: 'invalid_transition',
  PayloadTooLarge: 'payload_too_large',
  UnsupportedMediaType: 'unsupported_media_type',
  RateLimited: 'rate_limited',
  Internal: 'internal',
  /** A service the request depends on (the certificate authority) did not answer. */
  ServiceUnavailable: 'service_unavailable',
  /**
   * The caller's roles require a second factor and the session was opened without one: sign in
   * again with acr_values=mfa (M3-08, ADR-0021).
   */
  MfaRequired: 'mfa_required',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  invalid_transition: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  service_unavailable: 503,
  mfa_required: 403,
};

export function problemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}

/**
 * Business rules of the API whose field errors the portal shows in the user's language (M6-02,
 * WCAG 3.1.2). The error carries `key` and `params`; `message` stays in English for API
 * clients. The portal's texts are `apiErrors.fields.<key>` in its messages.
 */
export const FieldErrorKey = {
  UnknownApplication: 'unknown_application',
  PurposeNotAllowed: 'purpose_not_allowed',
  PurposeRetired: 'purpose_retired',
  UnknownOperations: 'unknown_operations',
  NoReadOnlyOperations: 'no_read_only_operations',
  MaxValidityMonths: 'max_validity_months',
  NoSandbox: 'no_sandbox',
  UnknownSubscription: 'unknown_subscription',
  RenewalKeepsTerms: 'renewal_keeps_terms',
  OperationsNotRequested: 'operations_not_requested',
  AtMostRequestedMonths: 'at_most_requested_months',
  AtMostRatePerMinute: 'at_most_rate_per_minute',
  UnknownTaxIdType: 'unknown_tax_id_type',
  UnknownSector: 'unknown_sector',
  UnknownPurpose: 'unknown_purpose',
  InactivePurpose: 'inactive_purpose',
  SlugTaken: 'slug_taken',
  TaxIdTaken: 'tax_id_taken',
  DesignationDocumentMissing: 'designation_document_missing',
  OperatorCannotBeDesignee: 'operator_cannot_be_designee',
  PeriodTooLong: 'period_too_long',
  NotANodeOfEntity: 'not_a_node_of_entity',
  XroadMemberMissing: 'xroad_member_missing',
  XroadWrongInstance: 'xroad_wrong_instance',
  XroadOtherMember: 'xroad_other_member',
  /** The upstream type is not among those the deployment accepts (features.upstreams, P-04). */
  UpstreamTypeNotAllowed: 'upstream_type_not_allowed',
  /** An `xroad` upstream in a deployment without the operator's Security Server (P-04). */
  XroadNotConfigured: 'xroad_not_configured',
  IncompatibleChange: 'incompatible_change',
  /** Fields declared personal or sensitive in an API classified below `personal` (M-20). */
  /** A validation was requested again too soon, or too many in an hour (MB-2). */
  ValidationRateLimited: 'validation_rate_limited',
  ClassificationBelowFields: 'classification_below_fields',
  RetirementNotice: 'retirement_notice',
  ExportTooLarge: 'export_too_large',
  ManualStepsUseCaseOnly: 'manual_steps_use_case_only',
  EmptyDocument: 'empty_document',
  /** The antivirus found something in an uploaded document (M6-08). */
  DocumentInfected: 'document_infected',
  TooManyOpenRequests: 'too_many_open_requests',
  /** Approving a version whose automatic validations are still running (M4-06, P-07). */
  ValidationsPending: 'validations_pending',
  /** Approving a version whose automatic validations failed (M4-06, P-07). */
  ValidationsFailed: 'validations_failed',
  /** The uploaded kit bundle is not the declared one: its SHA-256 differs (P-03). */
  KitBundleChecksumMismatch: 'kit_bundle_checksum_mismatch',
  /** The uploaded kit bundle does not have the declared size (P-03). */
  KitBundleSizeMismatch: 'kit_bundle_size_mismatch',
  /** The release's bundle is already mirrored: its path never serves other bytes (P-03). */
  KitBundleMirrored: 'kit_bundle_mirrored',
  /** Removing or disabling the last active platform_admin (M-03). */
  LastPlatformAdmin: 'last_platform_admin',
  /** No portal account has that e-mail address (M-03). */
  UnknownAccount: 'unknown_account',
  /** A platform role goes only to an active account (M-03). */
  AccountNotActive: 'account_not_active',
} as const;

export type FieldErrorKey = (typeof FieldErrorKey)[keyof typeof FieldErrorKey];

/**
 * The key of a field error that is an input validation issue: `params` are the zod issue
 * without the input (code, expected, minimum...), which the portal renders with zod's locale.
 */
export const ZOD_ISSUE_KEY = 'zod';

export const fieldErrorSchema = z.object({
  path: z.string(),
  /** English, for API clients. */
  message: z.string(),
  /** A FieldErrorKey, a ValidationMessage key or ZOD_ISSUE_KEY: what the portal translates. */
  key: z.string().optional(),
  /** The values the message names (never what the caller typed). */
  params: z.record(z.string(), z.unknown()).optional(),
});

export type FieldErrorDetail = z.infer<typeof fieldErrorSchema>;

/** RFC 9457 problem details as returned by the portal API (`application/problem+json`). */
export const problemDetailsSchema = z.object({
  type: z.url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]),
  errors: z.array(fieldErrorSchema).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
