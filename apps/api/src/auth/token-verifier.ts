import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Identity proven by a valid access token of the people realm (rid-portal). */
export interface VerifiedIdentity {
  sub: string;
  email?: string;
  /** Keycloak's email_verified claim: the person proved they own the address (ADR-0018). */
  emailVerified: boolean;
  name?: string;
}

export interface TokenVerifier {
  /** Throws if the token is not a valid access token for the portal API. */
  verify(token: string): Promise<VerifiedIdentity>;
}

export const PORTAL_API_AUDIENCE = 'rid-portal-api';

/** Issuer of the people realm; must equal the `iss` Keycloak puts in tokens (KC_HOSTNAME). */
export const portalIssuer = (): string =>
  `${process.env.KEYCLOAK_URL ?? 'http://localhost:8080'}/realms/rid-portal`;

/**
 * Verifies Keycloak access tokens: RS256 signature against the realm keys (JWKS), issuer,
 * audience `rid-portal-api` and expiry (ARCHITECTURE.md §3.1). Keycloak only authenticates;
 * roles are never read from the token (ADR-0004).
 */
export function createTokenVerifier(options: {
  issuer: string;
  audience?: string;
  keys?: JWTVerifyGetKey;
}): TokenVerifier {
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(`${options.issuer}/protocol/openid-connect/certs`), {
      cooldownDuration: 30_000,
    });
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, {
        issuer: options.issuer,
        audience: options.audience ?? PORTAL_API_AUDIENCE,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      if (!payload.sub) throw new Error('token without sub');
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        emailVerified: payload.email_verified === true,
        name: typeof payload.name === 'string' ? payload.name : undefined,
      };
    },
  };
}
