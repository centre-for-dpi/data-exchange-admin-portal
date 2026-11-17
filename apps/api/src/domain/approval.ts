import { getCountryConfig } from '@den/config';

/**
 * The regulator must also approve (M2-04) when the country requires it for sensitive data and the
 * API is classified sensitive OR declares any sensitive exposed field: the field-level flag cannot
 * be bypassed by a lower API classification. Shared by API publication and access requests.
 */
export function requiresRegulator(classification: string, exposedFields: unknown): boolean {
  if (!getCountryConfig().features.approval.regulatorForSensitive) return false;
  const fields = Array.isArray(exposedFields)
    ? (exposedFields as Array<{ sensitive?: unknown }>)
    : [];
  return classification === 'sensitive' || fields.some((f) => f.sensitive === true);
}
