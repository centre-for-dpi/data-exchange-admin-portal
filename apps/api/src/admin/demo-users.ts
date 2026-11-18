import { PLATFORM_ROLES, type PlatformRole } from '@den/contracts';
import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService, Tx } from '../prisma/prisma.service.js';
import type { RealmUser } from '../seed/seed.js';

/**
 * The seed's demo users in a pilot (P-08): `pablo.plataforma`, `ana.operadora` and the rest of
 * `infra/keycloak/den-portal-realm.json`, with platform roles and the installer's demo password.
 * Once the operator's own people have their roles (`platform-roles-cli.ts`), whoever runs the
 * server disables them for good, from the command line (`demo-users-cli.ts`):
 *
 * - in the portal, the account is `disabled` (every API request answers 403, no notices) and its
 *   platform roles are revoked, so they count for nothing and come back with nobody;
 * - in Keycloak, the user is disabled and its sessions end, so it can no longer sign in;
 * - the seed, which runs on every start of a pilot, leaves a disabled account as it is.
 *
 * Every change in the portal is audited in the same transaction (rule 4). It refuses to leave the
 * network without an active `platform_admin` who is not a demo user.
 */
export const DEMO_USERS_ACTOR = { type: 'system' as const, id: 'cli:demo-users' };

export class DemoUsersError extends Error {}

export type KeycloakUserState = 'enabled' | 'disabled' | 'missing';

/** What the command needs from Keycloak's Admin API, realm den-portal (`keycloak-users.ts`). */
export interface DemoUsersKeycloak {
  state(id: string): Promise<KeycloakUserState>;
  /** Disables the user and ends its sessions; idempotent. */
  disable(id: string): Promise<'disabled' | 'unchanged' | 'missing'>;
}

type Db = Pick<PrismaService, '$transaction' | 'user' | 'userPlatformRole'>;
type Audit = Pick<AuditService, 'record'>;

export interface DemoUserState {
  username: string;
  email: string;
  /** `none`: the portal has no account for it (the seed did not run). */
  portal: 'active' | 'disabled' | 'none';
  platformRoles: PlatformRole[];
  /** `unknown`: Keycloak was not asked (no administrator credentials). */
  keycloak: KeycloakUserState | 'unknown';
}

export async function listDemoUsers(
  prisma: Db,
  personas: readonly RealmUser[],
  keycloak?: DemoUsersKeycloak,
): Promise<DemoUserState[]> {
  const users = await prisma.user.findMany({
    where: { keycloakSub: { in: personas.map((p) => p.id) } },
    include: { platformRoles: true },
  });
  const states: DemoUserState[] = [];
  for (const persona of personas) {
    const user = users.find((u) => u.keycloakSub === persona.id);
    states.push({
      username: persona.username,
      email: persona.email,
      portal: user ? user.status : 'none',
      platformRoles: (user?.platformRoles ?? []).map((r) => r.role),
      keycloak: keycloak ? await keycloak.state(persona.id) : 'unknown',
    });
  }
  return states;
}

export interface DisabledDemoUser {
  username: string;
  email: string;
  portal: 'disabled' | 'unchanged' | 'created_disabled' | 'skipped';
  rolesRevoked: PlatformRole[];
  keycloak: 'disabled' | 'unchanged' | 'missing';
}

export interface DisableDemoUsersResult {
  users: DisabledDemoUser[];
  /** Platform roles nobody but the demo users held: the operator should grant them. */
  warnings: string[];
}

export async function disableDemoUsers(
  prisma: Db,
  audit: Audit,
  keycloak: DemoUsersKeycloak,
  input: { personas: readonly RealmUser[]; reason?: string },
): Promise<DisableDemoUsersResult> {
  const { personas } = input;
  if (personas.length === 0) throw new DemoUsersError('The realm file has no demo users');
  const reason = input.reason?.trim() || undefined;
  const subs = personas.map((p) => p.id);

  // Keycloak first, read only: if it cannot be reached, nothing changes anywhere.
  try {
    for (const persona of personas) await keycloak.state(persona.id);
  } catch (error) {
    throw new DemoUsersError(
      `Keycloak did not answer (${(error as Error).message}): nothing was changed`,
    );
  }

  const notDemo = { status: 'active' as const, keycloakSub: { notIn: subs } };
  const results = await prisma.$transaction(async (tx: Tx) => {
    // Without a platform administrator of its own the operator could not approve entities, grant
    // roles or fix the network: the demo users stay until there is one.
    const admins = await tx.userPlatformRole.count({
      where: { role: 'platform_admin', user: notDemo },
    });
    if (admins === 0) {
      throw new DemoUsersError(
        'No active platform_admin other than the demo users: grant the role to one of your ' +
          'people first (platform-role grant <email> platform_admin)',
      );
    }

    const done: Array<Omit<DisabledDemoUser, 'keycloak'>> = [];
    for (const persona of personas) {
      let user = await tx.user.findUnique({ where: { keycloakSub: persona.id } });
      let portal: DisabledDemoUser['portal'] = 'unchanged';
      if (!user) {
        // A disabled account keeps the seed (and a first sign-in) from creating an active one.
        if (await tx.user.findUnique({ where: { email: persona.email } })) {
          done.push({ ...names(persona), portal: 'skipped', rolesRevoked: [] });
          continue;
        }
        user = await tx.user.create({
          data: {
            keycloakSub: persona.id,
            email: persona.email,
            fullName:
              [persona.firstName, persona.lastName].filter(Boolean).join(' ') || persona.username,
            status: 'disabled',
            createdBy: DEMO_USERS_ACTOR.id,
          },
        });
        await audit.record(tx, {
          actor: DEMO_USERS_ACTOR,
          action: 'user.created',
          target: { type: 'user', id: user.id },
          after: { ...user, ...(reason ? { reason } : {}) },
        });
        portal = 'created_disabled';
      } else if (user.status === 'active') {
        await tx.user.update({ where: { id: user.id }, data: { status: 'disabled' } });
        await audit.record(tx, {
          actor: DEMO_USERS_ACTOR,
          action: 'user.disabled',
          target: { type: 'user', id: user.id },
          before: { status: 'active' },
          after: { status: 'disabled', ...(reason ? { reason } : {}) },
        });
        portal = 'disabled';
      }

      const rolesRevoked: PlatformRole[] = [];
      const roles = await tx.userPlatformRole.findMany({ where: { userId: user.id } });
      for (const { role } of roles) {
        await tx.userPlatformRole.delete({ where: { userId_role: { userId: user.id, role } } });
        await audit.record(tx, {
          actor: DEMO_USERS_ACTOR,
          action: 'platform_role.revoked',
          target: { type: 'user', id: user.id },
          before: { role },
          ...(reason ? { after: { reason } } : {}),
        });
        rolesRevoked.push(role);
      }
      done.push({ ...names(persona), portal, rolesRevoked });
    }

    const warnings: string[] = [];
    for (const role of PLATFORM_ROLES) {
      if ((await tx.userPlatformRole.count({ where: { role, user: notDemo } })) === 0) {
        warnings.push(
          `nobody holds ${role} now: grant it with platform-role grant <email> ${role}`,
        );
      }
    }
    return { done, warnings };
  });

  // Keycloak after the portal: a run cut short here is finished by running it again.
  const users: DisabledDemoUser[] = [];
  for (const [i, persona] of personas.entries()) {
    let state: DisabledDemoUser['keycloak'];
    try {
      state = await keycloak.disable(persona.id);
    } catch (error) {
      throw new DemoUsersError(
        `The portal accounts are disabled, but Keycloak failed for ${persona.username} ` +
          `(${(error as Error).message}): run the command again`,
      );
    }
    users.push({ ...(results.done[i] as Omit<DisabledDemoUser, 'keycloak'>), keycloak: state });
  }
  return { users, warnings: results.warnings };
}

const names = (persona: RealmUser) => ({ username: persona.username, email: persona.email });
