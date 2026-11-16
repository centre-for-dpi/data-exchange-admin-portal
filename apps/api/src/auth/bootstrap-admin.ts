import type { Prisma } from '../generated/prisma/client.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * The network's first platform administrator in production (M6-05), where there is no seed: the
 * operator sets RID_BOOTSTRAP_ADMIN_EMAIL before that person's first sign-in. When someone
 * registers with exactly that address, verified by the identity provider, and the network has no
 * platform administrator at all, they get the role, audited. From then on the setting does nothing:
 * further roles are granted from the console (and the variable should be removed).
 */
export const BOOTSTRAP_ACTOR = { type: 'system' as const, id: 'bootstrap-admin' };

export interface BootstrapCandidate {
  userId: string;
  email: string;
  emailVerified: boolean;
}

type Tx = Pick<Prisma.TransactionClient, 'userPlatformRole'> &
  Parameters<AuditService['record']>[0];

export async function bootstrapPlatformAdmin(
  tx: Tx,
  audit: Pick<AuditService, 'record'>,
  candidate: BootstrapCandidate,
  configured: string | undefined,
  requestId?: string,
): Promise<boolean> {
  const wanted = configured?.trim().toLowerCase();
  if (!wanted || !candidate.emailVerified || candidate.email.toLowerCase() !== wanted) return false;
  // Only for a network without any: the setting cannot add administrators later.
  if ((await tx.userPlatformRole.count({ where: { role: 'platform_admin' } })) > 0) return false;
  await tx.userPlatformRole.create({
    data: { userId: candidate.userId, role: 'platform_admin', grantedBy: BOOTSTRAP_ACTOR.id },
  });
  await audit.record(tx, {
    actor: BOOTSTRAP_ACTOR,
    action: 'platform_role.granted',
    target: { type: 'user', id: candidate.userId },
    after: { role: 'platform_admin', reason: 'RID_BOOTSTRAP_ADMIN_EMAIL' },
    requestId,
  });
  return true;
}
