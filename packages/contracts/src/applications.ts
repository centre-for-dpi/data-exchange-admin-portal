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

export const credentialSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['client_secret', 'mtls_certificate']),
  status: z.enum(['active', 'rotating', 'revoked', 'expired']),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

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
