import { loadCountryConfig } from '@den/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from './realm.js';
import { SEED_ACTOR, runSeed, type SeedSummary } from './seed.js';

describe('development seed (M1-01)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService();
  const config = loadCountryConfig({ code: 'co' });
  const realmUsers = readRealmUsers();
  let second: SeedSummary;
  let auditAfterFirst: number;

  beforeAll(async () => {
    await runSeed(prisma, audit, { config, realmUsers });
    auditAfterFirst = await prisma.auditEvent.count({ where: { actorId: SEED_ACTOR } });
    second = await runSeed(prisma, audit, { config, realmUsers });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('is idempotent: a second run creates, updates and audits nothing', async () => {
    expect(second.created).toEqual({
      entities: 0,
      users: 0,
      platformRoles: 0,
      memberships: 0,
      purposes: 0,
      kitReleases: 0,
    });
    expect(second.updated).toEqual({ purposes: 0 });
    expect(await prisma.auditEvent.count({ where: { actorId: SEED_ACTOR } })).toBe(auditAfterFirst);
  });

  it('creates the three fictitious entities as active, with the configured id type', async () => {
    const entities = await prisma.entity.findMany({
      where: { slug: { in: ['salud', 'socioeconomico', 'programas-sociales'] } },
    });
    expect(entities).toHaveLength(3);
    for (const entity of entities) {
      expect(entity.status).toBe('active');
      expect(entity.taxIdType).toBe(config.identifiers.organization[0]);
      expect(config.sectors.map((s) => s.code)).toContain(entity.sector);
    }
  });

  it('creates every Keycloak seed user with its fixed subject', async () => {
    for (const realmUser of realmUsers) {
      const user = await prisma.user.findUnique({ where: { keycloakSub: realmUser.id } });
      expect(user?.email, realmUser.username).toBe(realmUser.email);
    }
  });

  it('assigns platform roles and entity memberships as in docs/DEMO.md', async () => {
    const rolesOf = async (username: string) => {
      const sub = realmUsers.find((u) => u.username === username)?.id ?? '';
      return prisma.user.findUniqueOrThrow({
        where: { keycloakSub: sub },
        include: { platformRoles: true, memberships: { include: { entity: true } } },
      });
    };

    const ana = await rolesOf('ana.operadora');
    expect(ana.platformRoles.map((r) => r.role)).toEqual(['platform_reviewer']);
    expect(ana.memberships).toEqual([]);

    const lucia = await rolesOf('lucia.datos');
    expect(lucia.memberships.map((m) => [m.entity.slug, m.roles, m.status])).toEqual([
      ['salud', ['data_steward'], 'active'],
    ]);

    const pedro = await rolesOf('pedro.publicador');
    expect(pedro.memberships.map((m) => m.entity.slug).sort()).toEqual(['salud', 'socioeconomico']);

    const carlos = await rolesOf('carlos.dev');
    expect(carlos.memberships.map((m) => [m.entity.slug, m.roles])).toEqual([
      ['programas-sociales', ['app_developer']],
    ]);
  });

  it('offers a current kit version (P-03)', async () => {
    const current = await prisma.kitRelease.findFirst({
      where: { madeCurrentAt: { not: null } },
      orderBy: { madeCurrentAt: 'desc' },
    });
    expect(current?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loads the purpose catalogue from the country configuration', async () => {
    const purposes = await prisma.purpose.findMany({ where: { source: 'config' } });
    expect(purposes.map((p) => p.code).sort()).toEqual(config.purposes.map((p) => p.code).sort());
  });

  it('audits what it created', async () => {
    const actions = await prisma.auditEvent.groupBy({
      by: ['action'],
      where: { actorId: SEED_ACTOR },
      _count: true,
    });
    expect(actions.map((a) => a.action).sort()).toEqual(
      expect.arrayContaining([
        'entity.created',
        'membership.created',
        'platform_role.granted',
        'purpose.created',
        'user.created',
      ]),
    );
  });
});
