import { Injectable } from '@nestjs/common';
import { type CryptoKey, importJWK, type JWK } from 'jose';
import { z } from 'zod';

const privateJwkSchema = z.looseObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
  d: z.string().min(1),
  kid: z.string().min(1).max(100),
});
const publicJwkSchema = z.looseObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1),
  kid: z.string().min(1).max(100),
});

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
}

/**
 * The operator's key that signs the checkpoints (ADR-0016): RID_TRANSPARENCY_SIGNING_JWK, a
 * private Ed25519 JWK with kid. The JWKS publishes it with the retired public keys
 * (RID_TRANSPARENCY_RETIRED_JWKS), so receipts signed before a rotation keep verifying.
 */
@Injectable()
export class TransparencySigningKey {
  private key?: Promise<CryptoKey>;

  configured(): boolean {
    return Boolean(process.env.RID_TRANSPARENCY_SIGNING_JWK);
  }

  private privateJwk() {
    const raw = process.env.RID_TRANSPARENCY_SIGNING_JWK;
    if (!raw) throw new Error('RID_TRANSPARENCY_SIGNING_JWK is not set');
    return privateJwkSchema.parse(JSON.parse(raw));
  }

  kid(): string {
    return this.privateJwk().kid;
  }

  signingKey(): Promise<CryptoKey> {
    this.key ??= importJWK(this.privateJwk() as JWK, 'EdDSA') as Promise<CryptoKey>;
    return this.key;
  }

  /** Public keys only: the current one first, then the retired ones. */
  jwks(): { keys: PublicJwk[] } {
    const toPublic = ({ x, kid }: { x: string; kid: string }): PublicJwk => ({
      kty: 'OKP',
      crv: 'Ed25519',
      x,
      kid,
      alg: 'EdDSA',
      use: 'sig',
    });
    const retired = z
      .array(publicJwkSchema)
      .parse(JSON.parse(process.env.RID_TRANSPARENCY_RETIRED_JWKS || '[]'));
    const current = this.configured() ? [toPublic(this.privateJwk())] : [];
    const keys = [...current, ...retired.map(toPublic)];
    return { keys: keys.filter((k, i) => keys.findIndex((o) => o.kid === k.kid) === i) };
  }
}
