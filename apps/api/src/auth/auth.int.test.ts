import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { type MeResponse, meResponseSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

/**
 * M1-02: authentication and entity scoping. For every endpoint: the right role can, other
 * members get 403, other entities get 404 (CLAUDE.md, definition of done).
 */
describe('session and entity context (M1-02)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  const entity: Record<string, string> = {};

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    for (const e of await prisma.entity.findMany({
      where: { slug: { in: ['salud', 'socioeconomico', 'programas-sociales'] } },
    })) {
      entity[e.slug] = e.id;
    }
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (url: string, username?: string, token?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers:
        token !== undefined
          ? { authorization: `Bearer ${token}` }
          : username
            ? { authorization: `Bearer ${await issuer.token(sub(username))}` }
            : {},
    });

  describe('authentication', () => {
    it('rejects calls without a token with a 401 problem', async () => {
      const res = await call('/api/v1/me');
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code: 'unauthenticated' });
    });

    it('rejects tokens with a wrong signature, audience or expiry', async () => {
      const lucia = sub('lucia.datos');
      for (const token of [
        await issuer.foreignToken(lucia),
        await issuer.token(lucia, { audience: 'den-gateway' }),
        await issuer.token(lucia, { expiresIn: Math.floor(Date.now() / 1000) - 60 }),
        'not-a-jwt',
      ]) {
        expect((await call('/api/v1/me', undefined, token)).statusCode).toBe(401);
      }
    });

    it('keeps public endpoints open', async () => {
      expect((await call('/api/v1/health')).statusCode).toBe(200);
    });
  });

  describe('GET /me', () => {
    const me = async (username: string): Promise<MeResponse> => {
      const res = await call('/api/v1/me', username);
      expect(res.statusCode).toBe(200);
      return meResponseSchema.parse(res.json());
    };

    it('returns entity roles from the database for a member', async () => {
      const lucia = await me('lucia.datos');
      expect(lucia.platformRoles).toEqual([]);
      expect(lucia.memberships).toEqual([
        {
          entity: { id: entity.salud, slug: 'salud', shortName: expect.any(String) as string },
          roles: ['data_steward'],
        },
      ]);
    });

    it('returns platform roles for operator staff', async () => {
      const ana = await me('ana.operadora');
      expect(ana.platformRoles).toEqual(['platform_reviewer']);
      expect(ana.memberships).toEqual([]);
    });

    it('lists every active membership of a user in several entities', async () => {
      const pedro = await me('pedro.publicador');
      expect(pedro.memberships.map((m) => m.entity.slug).sort()).toEqual([
        'salud',
        'socioeconomico',
      ]);
    });

    it('registers a new Keycloak user on first login, without roles, and audits it', async () => {
      const newSub = randomUUID();
      const email = `new.${newSub.slice(0, 8)}@example.org`;
      const token = await issuer.token(newSub, { email, name: 'Nueva Persona' });
      const first = await call('/api/v1/me', undefined, token);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        user: { email, fullName: 'Nueva Persona' },
        platformRoles: [],
        memberships: [],
      });
      await call('/api/v1/me', undefined, token);
      expect(await prisma.user.count({ where: { keycloakSub: newSub } })).toBe(1);
      expect(
        await prisma.auditEvent.count({ where: { action: 'user.registered', actorId: newSub } }),
      ).toBe(1);
    });

    it('survives the first requests of a new person arriving at once (B-21)', async () => {
      const newSub = randomUUID();
      const email = `race.${newSub.slice(0, 8)}@example.org`;
      const token = await issuer.token(newSub, { email, name: 'Carrera Inicial' });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => call('/api/v1/me', undefined, token)),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
      expect(await prisma.user.count({ where: { keycloakSub: newSub } })).toBe(1);
      expect(
        await prisma.auditEvent.count({ where: { action: 'user.registered', actorId: newSub } }),
      ).toBe(1);
    });

    it('still refuses a different identity that arrives with a registered e-mail', async () => {
      const first = randomUUID();
      const email = `dup.${first.slice(0, 8)}@example.org`;
      await call('/api/v1/me', undefined, await issuer.token(first, { email }));
      const other = await call(
        '/api/v1/me',
        undefined,
        await issuer.token(randomUUID(), { email }),
      );
      expect(other.statusCode).toBe(409);
    });
  });

  describe('GET /entities/:entityId (entity.read)', () => {
    const status = async (slug: string, username: string) =>
      (await call(`/api/v1/entities/${entity[slug]}`, username)).statusCode;

    it('lets members read their own entity', async () => {
      const res = await call(`/api/v1/entities/${entity.salud}`, 'lucia.datos');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: entity.salud, slug: 'salud', status: 'active' });
    });

    it('answers 404 to members of another entity', async () => {
      expect(await status('salud', 'carlos.dev')).toBe(404);
    });

    it('lets the operator and the regulator read any entity, but not the auditor', async () => {
      expect(await status('salud', 'ana.operadora')).toBe(200);
      expect(await status('programas-sociales', 'marta.regulador')).toBe(200);
      expect(await status('salud', 'sofia.auditora')).toBe(404);
    });

    it('answers 404 for unknown or malformed entity ids, even to platform roles', async () => {
      expect((await call(`/api/v1/entities/${randomUUID()}`, 'ana.operadora')).statusCode).toBe(
        404,
      );
      expect((await call('/api/v1/entities/not-a-uuid', 'ana.operadora')).statusCode).toBe(404);
    });
  });

  describe('GET /entities/:entityId/members (entity.members.read)', () => {
    const url = (slug: string) => `/api/v1/entities/${entity[slug]}/members`;

    it('lets the entity admin list members', async () => {
      const res = await call(url('salud'), 'elena.admin');
      expect(res.statusCode).toBe(200);
      const emails = res
        .json<{ items: Array<{ user: { email: string } }> }>()
        .items.map((m) => m.user.email);
      expect(emails).toEqual(expect.arrayContaining(['lucia.datos@demo.den.example']));
    });

    it('answers 403 to members without the role', async () => {
      const res = await call(url('salud'), 'lucia.datos');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'forbidden' });
    });

    it('answers 404 to other entities and to platform roles not allowed for the action', async () => {
      expect((await call(url('salud'), 'carlos.dev')).statusCode).toBe(404);
      expect((await call(url('salud'), 'ana.operadora')).statusCode).toBe(404);
      expect((await call(url('salud'), 'pablo.plataforma')).statusCode).toBe(200);
    });

    it('paginates with a cursor', async () => {
      const first = (await call(`${url('salud')}?limit=1`, 'elena.admin')).json<{
        items: Array<{ membershipId: string }>;
        nextCursor: string | null;
      }>();
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = (
        await call(`${url('salud')}?limit=1&cursor=${first.nextCursor}`, 'elena.admin')
      ).json<{ items: Array<{ membershipId: string }> }>();
      expect(second.items[0]?.membershipId).not.toBe(first.items[0]?.membershipId);
      expect((await call(`${url('salud')}?limit=1000`, 'elena.admin')).statusCode).toBe(400);
    });
  });

  describe('roles are re-evaluated on every request (ADR-0004)', () => {
    it('a revoked membership loses access on the next request', async () => {
      const newSub = randomUUID();
      const user = await prisma.user.create({
        data: {
          keycloakSub: newSub,
          email: `member.${newSub.slice(0, 8)}@example.org`,
          fullName: 'Temporary member',
          createdBy: 'system:test',
        },
      });
      const membership = await prisma.membership.create({
        data: {
          userId: user.id,
          entityId: entity['programas-sociales'] ?? '',
          roles: ['entity_viewer'],
          status: 'active',
          createdBy: 'system:test',
        },
      });
      const token = await issuer.token(newSub);
      const url = `/api/v1/entities/${entity['programas-sociales']}`;
      expect((await call(url, undefined, token)).statusCode).toBe(200);

      await prisma.membership.update({ where: { id: membership.id }, data: { status: 'revoked' } });
      // Same, still valid token: access is gone.
      expect((await call(url, undefined, token)).statusCode).toBe(404);
    });

    it('a disabled user is rejected with 403', async () => {
      const newSub = randomUUID();
      await prisma.user.create({
        data: {
          keycloakSub: newSub,
          email: `disabled.${newSub.slice(0, 8)}@example.org`,
          fullName: 'Disabled',
          status: 'disabled',
          createdBy: 'system:test',
        },
      });
      const res = await call('/api/v1/me', undefined, await issuer.token(newSub));
      expect(res.statusCode).toBe(403);
    });
  });
});
