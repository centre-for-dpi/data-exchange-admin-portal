/**
 * The contracts' own validation messages, by key (M6-02, WCAG 3.1.2). The API answers a failed
 * check with its English message and this key (`apiErrors.fields.<key>` in the portal), so the
 * portal shows it in the user's language. Each message is used in one place only: the key is
 * found from the message.
 */
export const ValidationMessage = {
  api_slug_format: 'lower-case letters, digits and hyphens (3-40)',
  not_only_dots: 'cannot be only dots',
  https_url: 'must be an https:// URL',
  public_host_required: 'must be a public host name or IP, not an internal address',
  absolute_path: 'must be an absolute path',
  version_format: 'major.minor, e.g. 1.0',
  explain_changes: 'explain what has to change (10+ characters)',
  purpose_code_format: 'lower snake_case, e.g. benefit_targeting',
  each_purpose_once: 'each purpose once',
  entity_slug_format: 'lower-case letters, digits and single hyphens',
  reserved_slug: 'reserved name',
  tax_id_format: 'digits, letters, dots and hyphens',
  explain_reason: 'explain the reason (10+ characters)',
  choose_a_role: 'choose at least one role',
  each_role_once: 'each role once',
  reference_act: 'reference the act or decision (10+ characters)',
  period_reversed: '`from` must not be after `to`',
  node_name_format: 'letters, digits, spaces, dots, dashes',
  wireguard_key: 'a WireGuard public key (base64, 32 bytes)',
  semantic_version: 'semantic version, e.g. 1.4.0',
  operations_repeat: 'operations must not repeat',
  explain_rejection: 'explain why the request is rejected (10+ characters)',
  explain_revocation: 'explain why access is revoked (10+ characters)',
  reference_legal_order: 'reference the legal order',
  file_name_format: 'a file name without path separators or control characters',
} as const;

export type ValidationMessageKey = keyof typeof ValidationMessage;

const BY_MESSAGE = new Map<string, ValidationMessageKey>(
  Object.entries(ValidationMessage).map(([key, message]) => [message, key as ValidationMessageKey]),
);

/** The key of one of the contracts' messages, or undefined (zod's own message). */
export const validationMessageKey = (message: string): ValidationMessageKey | undefined =>
  BY_MESSAGE.get(message);
