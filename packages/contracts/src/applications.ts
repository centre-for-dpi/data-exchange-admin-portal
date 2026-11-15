import { z } from 'zod';
import { pageOf } from './session.js';

export const appEnvironmentSchema = z.enum(['sandbox', 'production']);

/** Consumer application (SPEC.md §3, §4.3). */
export const createApplicationSchema = z.strictObject({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2_000),
  environment: appEnvironmentSchema,
  technicalContact: z.email(),
});
export type CreateApplicationInput = z.input<typeof createApplicationSchema>;

/**
 * State of the OAuth2 client in Keycloak, set by the reconciler: `pending` until the client exists
 * with the current secret, `ready` when it does, `error` when the last attempt failed.
 */
export const provisioningSchema = z.enum(['pending', 'ready', 'error']);
export type Provisioning = z.infer<typeof provisioningSchema>;

export const applicationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  environment: appEnvironmentSchema,
  status: z.enum(['active', 'suspended', 'deleted']),
  clientId: z.string(),
  provisioning: provisioningSchema,
  createdAt: z.iso.datetime(),
});
export type ApplicationSummary = z.infer<typeof applicationSummarySchema>;

/** Public facts of a client certificate issued by the portal's CA (M3-01). */
export const certificateInfoSchema = z.object({
  /** RFC 8705 thumbprint (`x5t#S256`): base64url of the SHA-256 of the DER certificate. */
  fingerprint: z.string(),
  /** Serial number, hexadecimal. */
  serial: z.string(),
  subject: z.string(),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  /** Within lifecycle.certificateExpiryWarningDays of notAfter. */
  expiringSoon: z.boolean(),
});
export type CertificateInfo = z.infer<typeof certificateInfoSchema>;

export const credentialSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['client_secret', 'mtls_certificate']),
  status: z.enum(['active', 'rotating', 'revoked', 'expired']),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** Present for mtls_certificate credentials. */
  certificate: certificateInfoSchema.nullable(),
});
export type CredentialView = z.infer<typeof credentialSchema>;

/** Largest CSR accepted, in characters of PEM (an RSA 4096 CSR is about 1.7 KB). */
export const CSR_MAX_LENGTH = 16_384;

/**
 * Body of a certificate request: a PKCS#10 CSR in PEM whose subject is `CN=<clientId>` (SPEC.md
 * §4.3). The portal signs it through step-ca; the private key never leaves the consumer.
 */
export const issueCertificateSchema = z.strictObject({
  csr: z.string().trim().min(1).max(CSR_MAX_LENGTH),
});
export type IssueCertificateInput = z.input<typeof issueCertificateSchema>;

/**
 * Field messages of a rejected CSR (path `csr`). Stable texts: the web shows them translated.
 */
export const CSR_ERRORS = {
  malformed: 'The CSR is not a PEM-encoded PKCS#10 certificate request',
  signature: 'The CSR signature does not verify with its own public key',
  subject: 'The CSR must name the application only: CN=<client id>, and no other alternative name',
  key: 'The key must be ECDSA P-256 or P-384, or RSA of 2048 to 4096 bits',
} as const;
export type CsrError = keyof typeof CSR_ERRORS;

/** Answer to a certificate request: the credential and the certificate with its chain (PEM). */
export const issuedCertificateSchema = z.object({
  credential: credentialSchema,
  certificatePem: z.string(),
});
export type IssuedCertificate = z.infer<typeof issuedCertificateSchema>;

/** Media type of the certificate download: the leaf followed by the issuing chain (RFC 8555). */
export const PEM_CHAIN_MEDIA_TYPE = 'application/pem-certificate-chain';

export const applicationDetailSchema = applicationSummarySchema.extend({
  description: z.string(),
  technicalContact: z.string(),
  /** Keycloak token endpoint of the rid-gateway realm (client_credentials). */
  tokenUrl: z.string(),
  credentials: z.array(credentialSchema),
});
export type ApplicationDetail = z.infer<typeof applicationDetailSchema>;

/** Returned only by the creation request: the secret is never shown again (SPEC.md §4.3). */
export const createdApplicationSchema = z.object({
  application: applicationDetailSchema,
  clientSecret: z.string(),
});
export type CreatedApplication = z.infer<typeof createdApplicationSchema>;

export const applicationPageSchema = pageOf(applicationSummarySchema);
export const applicationParamsSchema = z.strictObject({
  entityId: z.uuid(),
  applicationId: z.uuid(),
});

export const credentialParamsSchema = z.strictObject({
  entityId: z.uuid(),
  applicationId: z.uuid(),
  credentialId: z.uuid(),
});
