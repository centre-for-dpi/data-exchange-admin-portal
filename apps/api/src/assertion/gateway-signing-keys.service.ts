import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import {
  type GatewayJwks,
  type RotateGatewaySigningKeyInput,
  rotateGatewaySigningKeySchema,
} from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { open, seal } from '../common/secrets.js';
import type { GatewaySigningKey, Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/topics.js';

const DAY = 24 * 60 * 60 * 1000;
/** Advisory lock: one key creation at a time across API instances. */
const KEY_LOCK = 4_242_011;
const SYSTEM = { type: 'system' as const, id: 'system:gateway-signing-keys' };
const context = (kid: string) => `gateway-signing-key:${kid}`;

/**
 * The keys the gateway signs its assertions to providers with (ADR-0024, M6-10). The portal
 * generates them (EC P-256), keeps the private key sealed with RID_SECRETS_KEY, and the APISIX
 * reconciler pushes the current one into the rid-assertion plugin's metadata (encrypted in etcd
 * with the deployment's keyring). A key signs for lifecycle.assertionKeyRotationDays; then a new
 * one takes over. The JWKS lists every key ever used (newest first), except a compromised one, so
 * the assertions providers archived keep verifying.
 */
@Injectable()
export class GatewaySigningKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** The key that signs now: created on first use, replaced when its time is over. */
  async current(now = new Date()): Promise<{ kid: string; privateKeyPem: string }> {
    const key = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY_LOCK})`;
      const active = await GatewaySigningKeysService.active(tx);
      const days = getCountryConfig().lifecycle.assertionKeyRotationDays;
      if (active && now.getTime() < active.createdAt.getTime() + days * DAY) return active;
      return this.create(
        tx,
        active,
        { actor: SYSTEM, reason: active ? 'scheduled' : 'first' },
        now,
      );
    });
    return { kid: key.kid, privateKeyPem: open(key.sealedPrivateKey, context(key.kid)) };
  }

  async jwks(): Promise<GatewayJwks> {
    const keys = await this.prisma.gatewaySigningKey.findMany({
      where: { compromisedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { publicJwk: true },
    });
    return { keys: keys.map((k) => k.publicJwk as GatewayJwks['keys'][number]) };
  }

  /**
   * The operator's rotation (RUNBOOK.md §2.2): a new key signs from the next reconciliation.
   * With `compromised`, the previous key also leaves the JWKS: what it signed no longer verifies.
   */
  async rotate(
    principal: Principal,
    input: RotateGatewaySigningKeyInput,
    requestId?: string,
  ): Promise<{ kid: string; previous: string | null }> {
    const { compromised, reason } = rotateGatewaySigningKeySchema.parse(input);
    const actor = { type: 'user' as const, id: principal.keycloakSub };
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY_LOCK})`;
      const active = await GatewaySigningKeysService.active(tx);
      const created = await this.create(
        tx,
        active,
        { actor, reason, compromised, requestId },
        new Date(),
      );
      // The gateway takes the new key with its next pass: queue one now.
      await this.outbox.enqueue(tx, {
        topic: GATEWAY_SYNC_TOPIC,
        aggregate: 'gateway:all',
        payload: { reason: 'gateway_signing_key_rotated' },
      });
      return { kid: created.kid, previous: active?.kid ?? null };
    });
  }

  private static active(tx: Prisma.TransactionClient) {
    return tx.gatewaySigningKey.findFirst({
      where: { retiredAt: null, compromisedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async create(
    tx: Prisma.TransactionClient,
    previous: GatewaySigningKey | null,
    why: {
      actor: { type: 'user' | 'system'; id: string };
      reason: string;
      compromised?: boolean;
      requestId?: string;
    },
    now: Date,
  ): Promise<GatewaySigningKey> {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const kid = `rid-gw-${now.toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
    const jwk = publicKey.export({ format: 'jwk' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    if (previous) {
      await tx.gatewaySigningKey.update({
        where: { id: previous.id },
        data: { retiredAt: now, ...(why.compromised ? { compromisedAt: now } : {}) },
      });
    }
    const created = await tx.gatewaySigningKey.create({
      data: {
        kid,
        publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, use: 'sig', alg: 'ES256' },
        sealedPrivateKey: seal(pem, context(kid)),
        createdAt: now,
      },
    });
    await this.audit.record(tx, {
      actor: why.actor,
      action: 'gateway_signing_key.created',
      target: { type: 'gateway_signing_key', id: created.id },
      ...(previous ? { before: { kid: previous.kid } } : {}),
      after: {
        kid,
        reason: why.reason,
        ...(previous && why.compromised ? { previousCompromised: true } : {}),
      },
      ...(why.requestId ? { requestId: why.requestId } : {}),
    });
    return created;
  }
}
