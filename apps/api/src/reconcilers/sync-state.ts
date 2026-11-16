import type { PrismaService } from '../prisma/prisma.service.js';

/** Systems the portal reconciles; each row of sync_state belongs to one. */
export type SyncSystem = 'apisix' | 'keycloak' | 'opa' | 'wireguard' | 'opensearch';

/** The desired state of `target` was applied: in sync, attempts reset. */
export async function recordSyncSuccess(
  prisma: PrismaService,
  system: SyncSystem,
  target: string,
  desiredHash: string,
): Promise<void> {
  const now = new Date();
  await prisma.syncState.upsert({
    where: { target },
    create: {
      target,
      system,
      desiredHash,
      appliedHash: desiredHash,
      status: 'in_sync',
      appliedAt: now,
    },
    update: {
      desiredHash,
      appliedHash: desiredHash,
      status: 'in_sync',
      appliedAt: now,
      lastError: null,
      attempts: 0,
    },
  });
}

/** Applying `target` failed: the error (first 1000 characters) and one more attempt. */
export async function recordSyncError(
  prisma: PrismaService,
  system: SyncSystem,
  target: string,
  desiredHash: string,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await prisma.syncState.upsert({
    where: { target },
    create: { target, system, desiredHash, status: 'error', lastError: message, attempts: 1 },
    update: { desiredHash, status: 'error', lastError: message, attempts: { increment: 1 } },
  });
}
