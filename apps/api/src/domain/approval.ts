import { getCountryConfig } from '@den/config';
import { FieldErrorKey } from '@den/contracts';
import { ValidationError } from '../common/errors.js';

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

/**
 * The privacy controls (data subject, X-DEN-End-User, maximum validity) follow the API's
 * classification, so the declared fields cannot say more than it does: a field marked personal or
 * sensitive needs an API classified `personal` or `sensitive` (M-20, SPEC.md §5, ADR-0015).
 */
export function assertClassificationCoversFields(
  classification: string,
  exposedFields: unknown,
): void {
  if (classification === 'personal' || classification === 'sensitive') return;
  const fields = Array.isArray(exposedFields)
    ? (exposedFields as Array<{ personal?: unknown; sensitive?: unknown }>)
    : [];
  const offending = fields.some((f) => f.personal === true || f.sensitive === true);
  if (offending) {
    throw new ValidationError([
      {
        path: 'exposedFields',
        message: `Fields marked personal or sensitive need an API classified personal or sensitive (it is ${classification})`,
        key: FieldErrorKey.ClassificationBelowFields,
      },
    ]);
  }
}
