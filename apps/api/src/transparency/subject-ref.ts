import { createHmac } from 'node:crypto';

/**
 * Keyed pseudonym of a data subject (ADR-0015): HMAC-SHA-256(key, country|type|number), lowercase
 * hex. Must equal what OPA computes at the gateway (packages/policy/den/authz.rego, subject_ref):
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

/**
 * The number in the citizen's token, as the identity provider may format it, without spaces, dots
 * or hyphens and in upper case. The gateway never normalizes: it denies any spelling but the
 * canonical one (ADR-0030), which the result must then be (isCanonicalDocumentNumber).
 */
export const normalizeDocumentNumber = (value: string): string =>
  value
    .trim()
    .replace(/[\s.-]/g, '')
    .toUpperCase();

/** The key OPA's bundle carries; at least 32 characters, as the bundle requires. */
export function subjectRefKey(): string {
  const key = process.env.DEN_SUBJECT_REF_KEY ?? '';
  if (key.length < 32) throw new Error('DEN_SUBJECT_REF_KEY is missing or shorter than 32');
  return key;
}
