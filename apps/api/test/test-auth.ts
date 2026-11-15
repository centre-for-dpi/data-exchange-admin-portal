import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MFA_ACR } from '@rid/contracts';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { configureApp, createAdapter } from '../src/app.js';
import { AppModule } from '../src/app.module.js';
import {
  createTokenVerifier,
  PORTAL_API_AUDIENCE,
  TOKEN_VERIFIER,
} from '../src/auth/token-verifier.js';
import {
  type CitizenTokenVerifier,
  citizenTokenOptions,
  createCitizenTokenVerifier,
} from '../src/transparency/citizen/citizen-token-verifier.js';

const TEST_ISSUER = 'https://keycloak.test/realms/rid-portal';

export interface TestIssuer {
  /** Signs an access token like Keycloak would (RS256, issuer, audience, expiry). */
  token(
    sub: string,
    options?: {
      email?: string;
      emailVerified?: boolean;
      name?: string;
      audience?: string;
      expiresIn?: string | number;
      /** Keycloak's acr: 'mfa' by default (a session with the second factor); null omits it. */
      acr?: string | null;
    },
  ): Promise<string>;
  /** A token signed with a key the API does not trust. */
  foreignToken(sub: string): Promise<string>;
  verifier: ReturnType<typeof createTokenVerifier>;
}

export async function createTestIssuer(): Promise<TestIssuer> {
  const trusted = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(trusted.publicKey)), kid: 'test-key', alg: 'RS256' };
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });

  const sign = (
    key: Parameters<SignJWT['sign']>[0],
    sub: string,
    options: {
      email?: string;
      emailVerified?: boolean;
      name?: string;
      audience?: string;
      expiresIn?: string | number;
      acr?: string | null;
    } = {},
  ) =>
    new SignJWT({
      ...(options.acr === null ? {} : { acr: options.acr ?? MFA_ACR }),
      ...(options.email ? { email: options.email } : {}),
      ...(options.emailVerified === undefined ? {} : { email_verified: options.emailVerified }),
      ...(options.name ? { name: options.name } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(sub)
      .setIssuer(TEST_ISSUER)
      .setAudience(options.audience ?? PORTAL_API_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(key);

  return {
    token: (sub, options) => sign(trusted.privateKey, sub, options),
    foreignToken: (sub) => sign(foreign.privateKey, sub),
    verifier,
  };
}

/**
 * The real AppModule, with tokens verified against the test issuer instead of Keycloak. Extra
 * providers (e.g. the Keycloak admin client) can be replaced with in-memory fakes.
 */
export async function createTestApp(
  issuer: TestIssuer,
  overrides: Array<{ token: symbol; value: unknown }> = [],
): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(issuer.verifier);
  for (const { token, value } of overrides) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), {
    logger: ['error', 'warn'],
  });
  await configureApp(app);
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export const TEST_CITIZEN_ISSUER = 'https://identity.test/realms/rid-citizens';

export interface TestCitizenIssuer {
  /** Signs a citizen access token like the national identity provider would. */
  token(
    sub: string,
    options?: {
      documentType?: string | null;
      documentNumber?: string | null;
      azp?: string;
      audience?: string;
      expiresIn?: string | number;
      foreign?: boolean;
    },
  ): Promise<string>;
  verifier: CitizenTokenVerifier;
}

/** Citizen tokens (MT-05) against a local key instead of the rid-citizens realm. */
export async function createTestCitizenIssuer(): Promise<TestCitizenIssuer> {
  const trusted = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(trusted.publicKey)), kid: 'citizen-key', alg: 'RS256' };
  const verifier = createCitizenTokenVerifier({
    ...citizenTokenOptions(),
    issuer: TEST_CITIZEN_ISSUER,
    clients: ['carpeta-ciudadana'],
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  return {
    verifier,
    token: (sub, options = {}) => {
      const claims: Record<string, unknown> = { azp: options.azp ?? 'carpeta-ciudadana' };
      if (options.documentType !== null) claims.document_type = options.documentType ?? 'CC';
      if (options.documentNumber !== null) claims.document_number = options.documentNumber;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'citizen-key' })
        .setSubject(sub)
        .setIssuer(TEST_CITIZEN_ISSUER)
        .setAudience(options.audience ?? 'rid-transparency-api')
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m')
        .sign(options.foreign ? foreign.privateKey : trusted.privateKey);
    },
  };
}
