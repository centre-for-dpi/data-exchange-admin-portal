import { getCountryConfig } from '@den/config';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  DOCUMENT_NUMBER,
  normalizeDocumentNumber,
  subjectRef,
  subjectRefKey,
} from '../subject-ref.js';

export const CITIZEN_TOKEN_VERIFIER = Symbol('CITIZEN_TOKEN_VERIFIER');

/** A citizen proven by the national identity provider, as the transparency API knows them. */
export interface CitizenIdentity {
  sub: string;
  /** Keyed pseudonym of the citizen as data subject: what the gateway registered (ADR-0015). */
  ref: string;
  /** Citizen app the token was issued to (for example, the reference citizen app). */
  clientId: string;
}

export interface CitizenTokenVerifier {
  /** Throws unless the token is a valid citizen token issued to an authorized citizen app. */
  verify(token: string): Promise<CitizenIdentity>;
}

export interface CitizenTokenOptions {
  issuer: string;
  audience: string;
  /** Citizen apps whose tokens are accepted (azp / client_id). */
  clients: readonly string[];
  documentTypeClaim: string;
  documentNumberClaim: string;
  keys?: JWTVerifyGetKey;
}

export const citizenTokenOptions = (): CitizenTokenOptions => ({
  issuer:
    process.env.DEN_CITIZEN_ISSUER ??
    `${process.env.KEYCLOAK_URL ?? 'http://localhost:8080'}/realms/den-citizens`,
  audience: process.env.DEN_CITIZEN_AUDIENCE ?? 'den-transparency-api',
  clients: (process.env.DEN_CITIZEN_CLIENTS ?? 'citizen-app')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),
  documentTypeClaim: process.env.DEN_CITIZEN_DOCUMENT_TYPE_CLAIM ?? 'document_type',
  documentNumberClaim: process.env.DEN_CITIZEN_DOCUMENT_NUMBER_CLAIM ?? 'document_number',
});

/**
 * Verifies access tokens of the national digital identity (in development, the Keycloak realm
 * den-citizens): RS256 signature against the issuer's JWKS, issuer, audience, expiry, and an
 * authorized citizen app as azp. The document claims become the citizen's pseudonym with the
 * same key and normalization as the gateway; the number itself is not kept or returned.
 */
export function createCitizenTokenVerifier(options: CitizenTokenOptions): CitizenTokenVerifier {
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(`${options.issuer}/protocol/openid-connect/certs`), {
      cooldownDuration: 30_000,
    });
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      const client =
        typeof payload.azp === 'string'
          ? payload.azp
          : typeof payload.client_id === 'string'
            ? payload.client_id
            : '';
      if (!options.clients.includes(client)) throw new Error('not an authorized citizen app');
      if (!payload.sub) throw new Error('token without sub');

      const country = getCountryConfig();
      const types: readonly string[] = country.identifiers.person;
      const rawType = payload[options.documentTypeClaim];
      const documentType =
        rawType === undefined
          ? types[0]
          : typeof rawType === 'string'
            ? rawType.trim().toUpperCase()
            : '';
      if (!documentType || !types.includes(documentType)) throw new Error('unknown document type');
      const rawNumber = payload[options.documentNumberClaim];
      const documentNumber =
        typeof rawNumber === 'string' ? normalizeDocumentNumber(rawNumber) : '';
      if (!DOCUMENT_NUMBER.test(documentNumber)) throw new Error('no valid document number');

      return {
        sub: payload.sub,
        clientId: client,
        ref: subjectRef({
          key: subjectRefKey(),
          country: country.country.code,
          documentType,
          documentNumber,
        }),
      };
    },
  };
}
