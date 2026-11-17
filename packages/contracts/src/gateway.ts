import { z } from 'zod';

/**
 * Public keys of the gateway's assertions to providers (X-RID-Assertion, ADR-0024, M6-10): ES256,
 * by kid. Every key ever used is listed (newest first) unless it was compromised, so assertions a
 * provider archived keep verifying.
 */
export const gatewayJwksSchema = z.object({
  keys: z.array(
    z.looseObject({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      x: z.string(),
      y: z.string(),
      kid: z.string(),
      use: z.literal('sig'),
      alg: z.literal('ES256'),
    }),
  ),
});
export type GatewayJwks = z.infer<typeof gatewayJwksSchema>;

/** The operator rotates the signing key now; `compromised` takes the previous one out of the JWKS. */
export const rotateGatewaySigningKeySchema = z.strictObject({
  compromised: z.boolean().default(false),
  reason: z.string().trim().min(10).max(500),
});
export type RotateGatewaySigningKeyInput = z.input<typeof rotateGatewaySigningKeySchema>;

export const gatewaySigningKeyRotatedSchema = z.object({
  /** The key that signs from now on. */
  kid: z.string(),
  /** The one it replaced, if any. */
  previous: z.string().nullable(),
});
