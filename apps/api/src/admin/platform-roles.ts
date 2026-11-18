import { PLATFORM_ROLES, type PlatformRole } from '@den/contracts';
import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService, Tx } from '../prisma/prisma.service.js';

/**
 * Platform roles from the server's command line (`platform-roles-cli.ts`): how the operator gives
 * its own people the roles that no screen grants yet (operator, reviewer, regulator, auditor). The
 * person registers in the portal and signs in once; then whoever runs the server grants the role.
 * Every change is audited in the same transaction, as the command line actor (rule 4).
 */
export const CLI_ACTOR = { type: 'system' as const, id: 'cli:platform-roles' };

export class PlatformRoleError extends Error {}

type Db = Pick<PrismaService, '$transaction' | 'userPlatformRole'>;
type Audit = Pick<AuditService, 'record'>;

export interface PlatformRoleChange {
  email: string;
  role: string;
  /** Why, in the operator's words: it goes into the audit trail. */
  reason?: string;
}

export interface PlatformRoleResult {
  outcome: 'granted' | 'revoked' | 'unchanged';
  email: string;
  role: PlatformRole;
}

function parse(change: PlatformRoleChange): { email: string; role: PlatformRole; reason?: string } {
  const email = change.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new PlatformRoleError(`"${change.email}" is not an e-mail address`);
  }
  if (!(PLATFORM_ROLES as readonly string[]).includes(change.role)) {
    throw new PlatformRoleError(
      `"${change.role}" is not a platform role: use one of ${PLATFORM_ROLES.join(', ')}`,
    );
  }
  const reason = change.reason?.trim() || undefined;
  return { email, role: change.role as PlatformRole, reason };
}

async function activeUser(tx: Tx, email: string) {
  const user = await tx.user.findUnique({ where: { email } });
  if (!user) {
    throw new PlatformRoleError(
      `No portal account with ${email}: the person must register with that address, verify it ` +
        'and sign in once before a role can be granted',
    );
  }
  if (user.status !== 'active') {
    throw new PlatformRoleError(`The account ${email} is ${user.status}`);
  }
  return user;
}

export async function grantPlatformRole(
  prisma: Db,
  audit: Audit,
  change: PlatformRoleChange,
): Promise<PlatformRoleResult> {
  const { email, role, reason } = parse(change);
  return prisma.$transaction(async (tx) => {
    const user = await activeUser(tx, email);
    const key = { userId_role: { userId: user.id, role } };
    if (await tx.userPlatformRole.findUnique({ where: key })) {
      return { outcome: 'unchanged' as const, email, role };
    }
    await tx.userPlatformRole.create({ data: { userId: user.id, role, grantedBy: CLI_ACTOR.id } });
    await audit.record(tx, {
      actor: CLI_ACTOR,
      action: 'platform_role.granted',
      target: { type: 'user', id: user.id },
      after: { role, ...(reason ? { reason } : {}) },
    });
    return { outcome: 'granted' as const, email, role };
  });
}

export async function revokePlatformRole(
  prisma: Db,
  audit: Audit,
  change: PlatformRoleChange,
): Promise<PlatformRoleResult> {
  const { email, role, reason } = parse(change);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) throw new PlatformRoleError(`No portal account with ${email}`);
    const key = { userId_role: { userId: user.id, role } };
    if (!(await tx.userPlatformRole.findUnique({ where: key }))) {
      return { outcome: 'unchanged' as const, email, role };
    }
    // Without a platform administrator nobody could approve entities or fix the network.
    if (role === 'platform_admin' && (await tx.userPlatformRole.count({ where: { role } })) <= 1) {
      throw new PlatformRoleError(
        `${email} is the last platform_admin: grant the role to someone else first`,
      );
    }
    await tx.userPlatformRole.delete({ where: key });
    await audit.record(tx, {
      actor: CLI_ACTOR,
      action: 'platform_role.revoked',
      target: { type: 'user', id: user.id },
      before: { role },
      ...(reason ? { after: { reason } } : {}),
    });
    return { outcome: 'revoked' as const, email, role };
  });
}

export interface PlatformRoleHolder {
  email: string;
  fullName: string;
  status: string;
  role: PlatformRole;
  grantedBy: string;
  grantedAt: string;
}

export async function listPlatformRoles(prisma: Db): Promise<PlatformRoleHolder[]> {
  const rows = await prisma.userPlatformRole.findMany({
    include: { user: { select: { email: true, fullName: true, status: true } } },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({
    email: r.user.email,
    fullName: r.user.fullName,
    status: r.user.status,
    role: r.role,
    grantedBy: r.grantedBy,
    grantedAt: r.createdAt.toISOString(),
  }));
}
