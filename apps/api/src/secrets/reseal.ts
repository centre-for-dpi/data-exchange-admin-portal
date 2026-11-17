import { AuditService } from '../audit/audit.service.js';
import { currentSecretsKeyId, needsReseal, open, seal } from '../common/secrets.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Where the portal keeps sealed values, and the context each one is bound to. */
const SEALED = {
  credential: { context: (row: { id: string }) => row.id },
  gatewayCertificate: { context: (row: { id: string }) => row.id },
  gatewaySigningKey: { context: (row: { kid: string }) => `gateway-signing-key:${row.kid}` },
} as const;

export interface ResealSummary {
  keyId: string;
  resealed: Record<keyof typeof SEALED, number>;
}

const SYSTEM = { type: 'system' as const, id: 'system:secrets-reseal' };

/**
 * Seals again with RID_SECRETS_KEY every value sealed with a previous key (ASVS 11.1, rotation
 * of OPERATIONS.md §5.6). Idempotent: a value already sealed with the current key is left alone,
 * and one that changed meanwhile is skipped (a later run takes it). A value no configured key
 * opens stops the run: nothing is lost, the operator adds the missing previous key and runs it
 * again. When at least one value was resealed, one `secrets.resealed` event records the counts and
 * the new key's id (never a key).
 */
export async function resealAll(
  prisma: PrismaService,
  audit: AuditService,
): Promise<ResealSummary> {
  const keyId = currentSecretsKeyId();
  const resealed = { credential: 0, gatewayCertificate: 0, gatewaySigningKey: 0 };

  const credentials = await prisma.credential.findMany({
    where: { sealedSecret: { not: null } },
    select: { id: true, sealedSecret: true },
  });
  for (const row of credentials) {
    if (!row.sealedSecret || !needsReseal(row.sealedSecret)) continue;
    const value = seal(open(row.sealedSecret, SEALED.credential.context(row)), row.id);
    const { count } = await prisma.credential.updateMany({
      where: { id: row.id, sealedSecret: row.sealedSecret },
      data: { sealedSecret: value },
    });
    resealed.credential += count;
  }

  const certificates = await prisma.gatewayCertificate.findMany({
    select: { id: true, sealedKey: true },
  });
  for (const row of certificates) {
    if (!needsReseal(row.sealedKey)) continue;
    const value = seal(open(row.sealedKey, row.id), row.id);
    const { count } = await prisma.gatewayCertificate.updateMany({
      where: { id: row.id, sealedKey: row.sealedKey },
      data: { sealedKey: value },
    });
    resealed.gatewayCertificate += count;
  }

  const signingKeys = await prisma.gatewaySigningKey.findMany({
    select: { id: true, kid: true, sealedPrivateKey: true },
  });
  for (const row of signingKeys) {
    if (!needsReseal(row.sealedPrivateKey)) continue;
    const context = SEALED.gatewaySigningKey.context(row);
    const value = seal(open(row.sealedPrivateKey, context), context);
    const { count } = await prisma.gatewaySigningKey.updateMany({
      where: { id: row.id, sealedPrivateKey: row.sealedPrivateKey },
      data: { sealedPrivateKey: value },
    });
    resealed.gatewaySigningKey += count;
  }

  const total = Object.values(resealed).reduce((a, b) => a + b, 0);
  if (total > 0) {
    await prisma.$transaction(async (tx) => {
      await audit.record(tx, {
        actor: SYSTEM,
        action: 'secrets.resealed',
        target: { type: 'secrets_key', id: keyId },
        after: { keyId, resealed },
      });
    });
  }
  return { keyId, resealed };
}
