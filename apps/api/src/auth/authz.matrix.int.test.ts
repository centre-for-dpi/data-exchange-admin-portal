import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ENTITY_ROLES, type EntityRole, PLATFORM_ROLES, type PlatformRole } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { API_PREFIX } from '../app.js';
import { MAIL_TRANSPORT } from '../mail/mail.service.js';
import { type DiscoveredRoute, OpenApiService } from '../openapi/openapi.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ENTITY_PERMISSIONS, PLATFORM_PERMISSIONS } from './authz.policy.js';

/**
 * Generated authorization test (M2-03): every route of the API, called by every kind of caller,
 * must get the answer the central policy (authz.policy.ts) promises:
 *   - anonymous: 401 on anything that is not public;
 *   - entity routes: allowed roles pass the guard; a member without the role gets 403; anyone
 *     outside the entity (no membership and no allowed platform role) gets 404;
 *   - platform routes: allowed platform roles pass; everyone else gets 403.
 * "Passes the guard" means the handler ran: any answer but 401, 403 or the guard's own 404. Path
 * ids other than the entity are random, so handlers answer 400/404 and nothing is changed.
 */

interface Persona {
  label: string;
  sub: string;
  email: string;
  entityRole?: EntityRole;
  platformRole?: PlatformRole;
  outsider?: boolean;
}

/** Routes that walk the whole database when allowed: only their denials are exercised here. */
const EXPENSIVE = new Set(['AuditController.verify', 'TransparencyController.verify']);

const GUARD_NOT_FOUND = 'Entity not found';

describe('authorization matrix: every endpoint × every role (M2-03)', () => {
  const prisma = new PrismaService();
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let routes: DiscoveredRoute[];
  let entityId = '';
  const personas: Persona[] = [];

  async function user(label: string): Promise<Persona & { userId: string }> {
    const id = randomUUID().slice(0, 8);
    const p = { label, sub: randomUUID(), email: `authz.${label}.${id}@example.org` };
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${await token(p)}` },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { keycloakSub: p.sub } });
    return { ...p, userId: row.id };
  }

  const token = (p: { sub: string; email: string }) =>
    issuer.token(p.sub, { email: p.email, name: p.email, emailVerified: true });

  async function newEntity(label: string): Promise<string> {
    const id = randomUUID().slice(0, 8);
    const row = await prisma.entity.create({
      data: {
        legalName: `Authz ${label} ${id}`,
        shortName: `AZ ${id}`,
        slug: `authz-${label}-${id}`,
        taxIdType: 'NIT',
        taxId: `7${id}`,
        kind: 'national',
        sector: 'salud',
        status: 'active',
        contactEmail: `c.${id}@example.org`,
        dpoName: 'Dora',
        dpoEmail: `d.${id}@example.org`,
        createdBy: 'test',
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      { token: MAIL_TRANSPORT, value: { send: () => Promise.resolve() } },
    ]);
    const service = app.get(OpenApiService);
    service.setGlobalPrefix(API_PREFIX);
    routes = service.routes();

    entityId = await newEntity('target');
    const otherId = await newEntity('other');
    for (const role of ENTITY_ROLES) {
      const p = await user(role);
      await prisma.membership.create({
        data: { userId: p.userId, entityId, roles: [role], status: 'active', createdBy: 'test' },
      });
      personas.push({ ...p, entityRole: role });
    }
    for (const role of PLATFORM_ROLES) {
      const p = await user(role);
      await prisma.userPlatformRole.create({ data: { userId: p.userId, role, grantedBy: 'test' } });
      personas.push({ ...p, platformRole: role });
    }
    const outsider = await user('outsider');
    await prisma.membership.create({
      data: {
        userId: outsider.userId,
        entityId: otherId,
        roles: [...ENTITY_ROLES],
        status: 'active',
        createdBy: 'test',
      },
    });
    personas.push({ ...outsider, outsider: true });
    personas.push(await user('no-role'));
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const urlOf = (route: DiscoveredRoute) =>
    route.path.replace(/:(\w+)/g, (_m, name: string) =>
      name === 'entityId' ? entityId : randomUUID(),
    );

  async function call(route: DiscoveredRoute, persona?: Persona) {
    const write = route.method === 'POST' || route.method === 'PUT';
    const res = await app.inject({
      method: route.method as 'GET' | 'POST' | 'PUT',
      url: urlOf(route),
      headers: persona ? { authorization: `Bearer ${await token(persona)}` } : {},
      ...(write ? { payload: {} } : {}),
    });
    const detail = (() => {
      try {
        return res.json<{ detail?: string }>().detail;
      } catch {
        return undefined;
      }
    })();
    return { status: res.statusCode, detail };
  }

  /** What the policy promises a persona on a route. */
  function expected(route: DiscoveredRoute, p: Persona): 'pass' | 403 | 404 {
    const { access } = route;
    if (access.kind === 'entity') {
      const rule = ENTITY_PERMISSIONS[access.action];
      if (p.entityRole && (rule.entityRoles as readonly string[]).includes(p.entityRole))
        return 'pass';
      if (p.platformRole && (rule.platformRoles as readonly string[]).includes(p.platformRole))
        return 'pass';
      return p.entityRole ? 403 : 404;
    }
    if (access.kind === 'platform') {
      const allowed: readonly string[] = PLATFORM_PERMISSIONS[access.action];
      return p.platformRole && allowed.includes(p.platformRole) ? 'pass' : 403;
    }
    return 'pass';
  }

  const passed = (r: { status: number; detail?: string }) =>
    r.status !== 401 && r.status !== 403 && !(r.status === 404 && r.detail === GUARD_NOT_FOUND);

  it('checks a meaningful number of routes and callers', () => {
    expect(routes.filter((r) => r.access.kind === 'entity').length).toBeGreaterThan(20);
    expect(routes.filter((r) => r.access.kind === 'platform').length).toBeGreaterThan(8);
    expect(personas).toHaveLength(ENTITY_ROLES.length + PLATFORM_ROLES.length + 2);
  });

  it('answers every protected route to every caller as the policy says', async () => {
    const mismatches: string[] = [];
    for (const route of routes) {
      const { kind } = route.access;
      if (kind === 'public' || kind === 'citizen' || kind === 'node' || kind === 'optional')
        continue;
      const name = `${route.method} ${route.path}`;

      const anonymous = await call(route);
      if (anonymous.status !== 401)
        mismatches.push(`${name} anonymous: ${anonymous.status} (want 401)`);

      for (const persona of personas) {
        const want = expected(route, persona);
        if (want === 'pass' && EXPENSIVE.has(route.handler)) continue;
        const got = await call(route, persona);
        const ok =
          want === 'pass'
            ? passed(got)
            : want === 404
              ? got.status === 404 && got.detail === GUARD_NOT_FOUND
              : got.status === 403;
        if (!ok)
          mismatches.push(
            `${name} ${persona.label}: ${got.status} ${got.detail ?? ''} (want ${want})`,
          );
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);
});
