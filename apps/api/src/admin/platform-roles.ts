import { PLATFORM_ROLES, type PlatformRole } from '@den/contracts';
import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService, Tx } from '../prisma/prisma.service.js';

/**
 * Platform roles and the status of accounts, shared by the server's command line
 * (`platform-roles-cli.ts`, which gives the operator's first people their roles) and by the
 * operator console (`platform-users.service.ts`, M-03). The person registers in the portal and
 * signs in once; then a platform administrator grants the role. Every change is audited in the
 * same transaction (rule 4), as the command line actor or as the signed-in administrator.
 */
export const CLI_ACTOR = { type: 'system' as const, id: 'cli:platform-roles' };

export type RoleActor = { type: 'system' | 'user'; id: string };

/** Why a change was refused, so the HTTP layer can word it (the command line prints the message). */
export type PlatformRoleErrorKind =
  'invalid' | 'unknown_account' | 'account_not_active' | 'last_platform_admin';

export class PlatformRoleError extends Error {
  constructor(
    message: string,
    readonly kind: PlatformRoleErrorKind = 'invalid',
  ) {
    super(message);
  }
}

type Db = Pick<PrismaService, '$transaction' | 'userPlatformRole'>;
type Audit = Pick<AuditService, 'record'>;

export interface PlatformRoleChange {
  email: string;
  role: string;
  /** Why, in the operator's words: it goes into the audit trail. */
  reason?: string;
  /** Who does it; the command line by default. */
  actor?: RoleActor;
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
      'unknown_account',
    );
  }
  if (user.status !== 'active') {
    throw new PlatformRoleError(`The account ${email} is ${user.status}`, 'account_not_active');
  }
  return user;
}

/**
 * Without an active platform administrator nobody could approve entities or fix the network: the
 * last one can neither lose the role nor be disabled. Two concurrent changes could each see the
 * other administrator, so the rows are locked first (the role rows of platform_admin).
 */
async function assertAnotherActiveAdmin(tx: Tx, userId: string, email: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM user_platform_role WHERE role = 'platform_admin' FOR UPDATE`;
  const others = await tx.userPlatformRole.count({
    where: { role: 'platform_admin', userId: { not: userId }, user: { status: 'active' } },
  });
  if (others === 0) {
    throw new PlatformRoleError(
      `${email} is the last platform_admin: grant the role to someone else first`,
      'last_platform_admin',
    );
  }
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
    const actor = change.actor ?? CLI_ACTOR;
    await tx.userPlatformRole.create({ data: { userId: user.id, role, grantedBy: actor.id } });
    await audit.record(tx, {
      actor,
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
    if (!user) throw new PlatformRoleError(`No portal account with ${email}`, 'unknown_account');
    const key = { userId_role: { userId: user.id, role } };
    if (!(await tx.userPlatformRole.findUnique({ where: key }))) {
      return { outcome: 'unchanged' as const, email, role };
    }
    if (role === 'platform_admin' && user.status === 'active') {
      await assertAnotherActiveAdmin(tx, user.id, email);
    }
    await tx.userPlatformRole.delete({ where: key });
    await audit.record(tx, {
      actor: change.actor ?? CLI_ACTOR,
      action: 'platform_role.revoked',
      target: { type: 'user', id: user.id },
      before: { role },
      ...(reason ? { after: { reason } } : {}),
    });
    return { outcome: 'revoked' as const, email, role };
  });
}

export interface PlatformRoleHolder {
  userId: string;
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
    userId: r.userId,
    email: r.user.email,
    fullName: r.user.fullName,
    status: r.user.status,
    role: r.role,
    grantedBy: r.grantedBy,
    grantedAt: r.createdAt.toISOString(),
  }));
}

export interface UserStatusChange {
  email: string;
  reason?: string;
  actor?: RoleActor;
}

export interface UserStatusResult {
  outcome: 'disabled' | 'enabled' | 'unchanged';
  email: string;
  status: 'active' | 'disabled';
}

/**
 * Disables or enables a portal account (M-03). A disabled account is refused on every API request
 * from the next one and gets no notices; its memberships and roles stay, inert, so enabling it
 * restores them. It does not touch the Keycloak user: the portal holds no administrator rights
 * there (ADR-0021), so the person can still sign in to Keycloak and reach nothing.
 */
export async function setUserStatus(
  prisma: Db,
  audit: Audit,
  change: UserStatusChange,
  to: 'active' | 'disabled',
): Promise<UserStatusResult> {
  const { email, reason } = parse({
    email: change.email,
    role: PLATFORM_ROLES[0],
    reason: change.reason,
  });
  const actor = change.actor ?? CLI_ACTOR;
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, include: { platformRoles: true } });
    if (!user) throw new PlatformRoleError(`No portal account with ${email}`, 'unknown_account');
    if (user.status === to) {
      return { outcome: 'unchanged' as const, email, status: to };
    }
    if (to === 'disabled' && user.platformRoles.some((r) => r.role === 'platform_admin')) {
      await assertAnotherActiveAdmin(tx, user.id, email);
    }
    await tx.user.update({ where: { id: user.id }, data: { status: to } });
    await audit.record(tx, {
      actor,
      action: to === 'disabled' ? 'user.disabled' : 'user.enabled',
      target: { type: 'user', id: user.id },
      before: { status: user.status },
      after: { status: to, ...(reason ? { reason } : {}) },
    });
    return {
      outcome: to === 'disabled' ? ('disabled' as const) : ('enabled' as const),
      email,
      status: to,
    };
  });
}
