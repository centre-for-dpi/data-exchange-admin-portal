import { createHash, X509Certificate } from 'node:crypto';
import { getCountryConfig } from '@rid/config';
import type { CredentialView } from '@rid/contracts';
import type { Credential } from '../generated/prisma/client.js';

const DAY = 24 * 60 * 60 * 1000;

/** RFC 8705 `x5t#S256`: base64url (no padding) of the SHA-256 of the DER certificate. */
export const thumbprintOf = (certificate: X509Certificate): string =>
  createHash('sha256').update(certificate.raw).digest('base64url');

/** The first certificate of a PEM chain. */
export function leafOf(chainPem: string): X509Certificate {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(chainPem);
  if (!match) throw new Error('No certificate in the chain');
  return new X509Certificate(match[0]);
}

/** Within lifecycle.certificateExpiryWarningDays of the end of its validity (SPEC.md §4.3). */
export function expiringSoon(notAfter: Date, now = new Date()): boolean {
  const days = getCountryConfig().lifecycle.certificateExpiryWarningDays;
  return notAfter.getTime() > now.getTime() && notAfter.getTime() <= now.getTime() + days * DAY;
}

/** Metadata of a credential as the API shows it: never a secret, its hash or its sealed copy. */
export function credentialView(c: Credential, now = new Date()): CredentialView {
  const certificate =
    c.kind === 'mtls_certificate' && c.fingerprint && c.serial && c.notBefore && c.notAfter
      ? {
          fingerprint: c.fingerprint,
          serial: c.serial,
          subject: c.certificatePem ? leafOf(c.certificatePem).subject : '',
          notBefore: c.notBefore.toISOString(),
          notAfter: c.notAfter.toISOString(),
          expiringSoon: c.status === 'active' && expiringSoon(c.notAfter, now),
        }
      : null;
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    rotationEndsAt: c.status === 'rotating' ? (c.rotationEndsAt?.toISOString() ?? null) : null,
    certificate,
  };
}
