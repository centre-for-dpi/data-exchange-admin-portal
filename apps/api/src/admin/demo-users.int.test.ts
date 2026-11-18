import { randomUUID } from 'node:crypto';
import { loadCountryConfig } from '@den/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type RealmUser, runSeed } from '../seed/seed.js';
import {
  DEMO_USERS_ACTOR,
  type DemoUsersKeycloak,
  DemoUsersError,
  disableDemoUsers,
  type KeycloakUserState,
  listDemoUsers,
} from './demo-users.js';

/** Keycloak's users in memory: enabled until disabled. */
class MemoryKeycloak implements DemoUsersKeycloak {
  readonly enabled = new Map<string, boolean>();
  down = false;
  state(id: string): Promise<KeycloakUserState> {
    if (this.down) return Promise.reject(new Error('connect ECONNREFUSED'));
    const enabled = this.enabled.get(id);
    return Promise.resolve(enabled === undefined ? 'missing' : enabled ? 'enabled' : 'disabled');
  }
  disable(id: string) {
    const enabled = this.enabled.get(id);
    if (enabled === undefined) return Promise.resolve('missing' as const);
    this.enabled.set(id, false);
    return Promise.resolve(enabled ? ('disabled' as const) : ('unchanged' as const));
  }
}

/**
 * P-08: the seed's demo users are disabled from the server's command line once the operator's
 * own people have their roles. Fresh demo users each run, so other tests keep the real ones.
 */
describe('demo users of a pilot (P-08)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService();
  const config = loadCountryConfig({ code: 'co' });
  const tag = randomUUID().slice(0, 8);
  const persona = (username: string): RealmUser => ({
    id: randomUUID(),
    username: `${username}.${tag}`,
    firstName: 'Demo',
    email: `${username}.${tag}@demo.den.example`,
  });
  const admin = persona('pablo');
  const regulator = persona('marta');
  // In the realm file, but the seed never created its portal account.
  const unseeded = persona('nadie');
  const personas = [admin, regulator, unseeded];
  const roles = {
    [admin.username]: { platform: ['platform_admin' as const] },
    [regulator.username]: { platform: ['regulator' as const] },
  };
  const seed = () =>
    runSeed(prisma, audit, { config, realmUsers: [admin, regulator], entities: [], roles });
  const keycloak = new MemoryKeycloak();
  const byActor = () =>
    prisma.auditEvent.findMany({
      where: { actorId: DEMO_USERS_ACTOR.id },
      orderBy: { seq: 'asc' },
    });
  const account = (p: RealmUser) =>
    prisma.user.findUnique({ where: { keycloakSub: p.id }, include: { platformRoles: true } });

  beforeAll(async () => {
    await seed();
    for (const p of [admin, regulator]) keycloak.enabled.set(p.id, true);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses while every active platform_admin is a demo user, and changes nothing', async () => {
    // Treat every current platform_admin of the test database as a demo user.
    const others = await prisma.user.findMany({
      where: { platformRoles: { some: { role: 'platform_admin' } } },
    });
    const everyone = [
      ...personas,
      ...others.map((u) => ({ id: u.keycloakSub, username: u.email, email: u.email })),
    ];
    const before = (await byActor()).length;
    await expect(disableDemoUsers(prisma, audit, keycloak, { personas: everyone })).rejects.toThrow(
      /No active platform_admin other than the demo users/,
    );
    expect((await account(admin))?.status).toBe('active');
    expect((await account(admin))?.platformRoles.map((r) => r.role)).toEqual(['platform_admin']);
    expect(await account(unseeded)).toBeNull();
    expect(keycloak.enabled.get(admin.id)).toBe(true);
    expect((await byActor()).length).toBe(before);
  });

  it('changes nothing when Keycloak does not answer', async () => {
    keycloak.down = true;
    try {
      await expect(disableDemoUsers(prisma, audit, keycloak, { personas })).rejects.toThrow(
        DemoUsersError,
      );
    } finally {
      keycloak.down = false;
    }
    expect((await account(admin))?.status).toBe('active');
  });

  describe('with a platform_admin of the operator', () => {
    let firstRun: Awaited<ReturnType<typeof disableDemoUsers>>;
    let auditAfterFirst: number;

    beforeAll(async () => {
      const own = await prisma.user.create({
        data: {
          keycloakSub: randomUUID(),
          email: `own.admin.${tag}@operador.example`,
          fullName: 'Own admin',
          status: 'active',
          createdBy: 'system:test',
        },
      });
      await prisma.userPlatformRole.create({
        data: { userId: own.id, role: 'platform_admin', grantedBy: 'system:test' },
      });
      firstRun = await disableDemoUsers(prisma, audit, keycloak, {
        personas,
        reason: 'Equipo propio con roles',
      });
      auditAfterFirst = (await byActor()).length;
    });

    it('disables each demo user in the portal and Keycloak and revokes its platform roles', async () => {
      expect(firstRun.users).toEqual([
        expect.objectContaining({
          username: admin.username,
          portal: 'disabled',
          rolesRevoked: ['platform_admin'],
          keycloak: 'disabled',
        }),
        expect.objectContaining({
          username: regulator.username,
          portal: 'disabled',
          rolesRevoked: ['regulator'],
          keycloak: 'disabled',
        }),
        expect.objectContaining({
          username: unseeded.username,
          portal: 'created_disabled',
          rolesRevoked: [],
          keycloak: 'missing',
        }),
      ]);
      for (const p of personas) {
        const user = await account(p);
        expect(user?.status, p.username).toBe('disabled');
        expect(user?.platformRoles, p.username).toEqual([]);
      }
      expect(keycloak.enabled.get(admin.id)).toBe(false);
      expect(keycloak.enabled.get(regulator.id)).toBe(false);
      expect(firstRun.warnings.join('\n')).not.toMatch(/platform_admin/);
    });

    it('audits every change as the command line, with the reason', async () => {
      const userId = (await account(admin))?.id;
      const events = (await byActor()).filter((e) => e.targetId === userId);
      expect(events.map((e) => [e.action, e.before, e.after])).toEqual([
        [
          'user.disabled',
          { status: 'active' },
          { status: 'disabled', reason: 'Equipo propio con roles' },
        ],
        [
          'platform_role.revoked',
          { role: 'platform_admin' },
          { reason: 'Equipo propio con roles' },
        ],
      ]);
      const unseededId = (await account(unseeded))?.id;
      const created = (await byActor()).filter((e) => e.targetId === unseededId);
      expect(created.map((e) => e.action)).toEqual(['user.created']);
    });

    it('is idempotent: a second run changes and audits nothing', async () => {
      const again = await disableDemoUsers(prisma, audit, keycloak, { personas });
      expect(again.users.map((u) => [u.portal, u.rolesRevoked, u.keycloak])).toEqual([
        ['unchanged', [], 'unchanged'],
        ['unchanged', [], 'unchanged'],
        ['unchanged', [], 'missing'],
      ]);
      expect((await byActor()).length).toBe(auditAfterFirst);
    });

    it('the seed, run again on the next start, leaves them disabled and without roles', async () => {
      const summary = await seed();
      expect(summary.created.users).toBe(0);
      expect(summary.created.platformRoles).toBe(0);
      expect(summary.warnings).toContain(
        `disabled, roles not granted: ${admin.username}, ${regulator.username}`,
      );
      expect((await account(admin))?.status).toBe('disabled');
      expect((await account(admin))?.platformRoles).toEqual([]);
    });

    it('lists each demo user with its state in the portal and in Keycloak', async () => {
      expect(await listDemoUsers(prisma, personas, keycloak)).toEqual([
        expect.objectContaining({ portal: 'disabled', platformRoles: [], keycloak: 'disabled' }),
        expect.objectContaining({ portal: 'disabled', platformRoles: [], keycloak: 'disabled' }),
        expect.objectContaining({ portal: 'disabled', platformRoles: [], keycloak: 'missing' }),
      ]);
      expect((await listDemoUsers(prisma, personas))[0]?.keycloak).toBe('unknown');
    });
  });
});
