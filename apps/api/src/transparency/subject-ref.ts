import { createHmac } from 'node:crypto';

/**
 * Keyed pseudonym of a data subject (ADR-0015): HMAC-SHA-256(key, country|type|number), lowercase
 * hex. Must equal what OPA computes at the gateway (packages/policy/rid/authz.rego, subject_ref):
 * the citizen API derives it from the citizen's token to find the calls about that person.
 */
export function subjectRef(input: {
  key: string;
  country: string;
  documentType: string;
  documentNumber: string;
}): string {
  return createHmac('sha256', input.key)
    .update(`${input.country}|${input.documentType}|${input.documentNumber}`)
    .digest('hex');
}

/** As OPA: no spaces, dots or hyphens, upper case. */
export const normalizeDocumentNumber = (value: string): string =>
  value
    .trim()
    .replace(/[\s.-]/g, '')
    .toUpperCase();

/** Numbers OPA accepts after normalization. */
export const DOCUMENT_NUMBER = /^[A-Z0-9]{3,20}$/;

/** The key OPA's bundle carries; at least 32 characters, as the bundle requires. */
export function subjectRefKey(): string {
  const key = process.env.RID_SUBJECT_REF_KEY ?? '';
  if (key.length < 32) throw new Error('RID_SUBJECT_REF_KEY is missing or shorter than 32');
  return key;
}
