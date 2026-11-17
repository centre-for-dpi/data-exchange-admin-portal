import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { meResponseSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

/**
 * M3-08: platform roles and data stewards need a second factor. Keycloak asks for the one-time
 * code when the web requests acr_values=mfa; the API checks the token's acr on every role-based
 * endpoint, so a session opened with the password alone cannot use those roles (ADR-0021).
 */
describe('second factor for critical roles (M3-08)', () => {
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
      where: { slug: { in: ['salud', 'programas-sociales'] } },
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

  /** acr as Keycloak sets it: 'password' without the code, 'mfa' after it, absent if unknown. */
  const call = async (url: string, username: string, acr: string | null) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await issuer.token(sub(username), { acr })}` },
    });

  const routes = {
    'lucia.datos': () => `/api/v1/entities/${entity.salud}/access-requests`,
    'ana.operadora': () => '/api/v1/review/api-versions',
    'pablo.plataforma': () => '/api/v1/admin/entities',
    'marta.regulador': () => '/api/v1/regulator/approvals',
    'sofia.auditora': () => '/api/v1/audit/events',
  };

  it.each(Object.keys(routes))(
    '%s gets 403 mfa_required with a password-only session, and 200 with the code',
    async (username) => {
      const url = routes[username as keyof typeof routes]();
      for (const acr of ['password', null, 'MFA', '2']) {
        const res = await call(url, username, acr);
        expect(res.statusCode, `acr=${acr}`).toBe(403);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.json()).toMatchObject({
          type: 'https://den.example/errors/mfa_required',
          code: 'mfa_required',
          status: 403,
        });
      }
      expect((await call(url, username, 'mfa')).statusCode).toBe(200);
    },
  );

  it('roles without the requirement keep working with the password alone', async () => {
    expect(
      (await call(`/api/v1/entities/${entity.salud}/apis`, 'pedro.publicador', 'password'))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          `/api/v1/entities/${entity['programas-sociales']}/applications`,
          'carlos.dev',
          'password',
        )
      ).statusCode,
    ).toBe(200);
  });

  it('/me stays reachable and says the session must step up', async () => {
    const before = meResponseSchema.parse(
      (await call('/api/v1/me', 'lucia.datos', 'password')).json(),
    );
    expect(before.mfa).toEqual({ required: true, satisfied: false });
    const after = meResponseSchema.parse((await call('/api/v1/me', 'lucia.datos', 'mfa')).json());
    expect(after.mfa).toEqual({ required: true, satisfied: true });
    const carlos = meResponseSchema.parse(
      (await call('/api/v1/me', 'carlos.dev', 'password')).json(),
    );
    expect(carlos.mfa).toEqual({ required: false, satisfied: false });
  });

  it('does not reveal other entities: a non-member still gets 404, not mfa_required', async () => {
    const res = await call(
      `/api/v1/entities/${entity['programas-sociales']}/access-requests`,
      'lucia.datos',
      'password',
    );
    expect(res.statusCode).toBe(404);
  });

  it('a role the person lacks is still 403 forbidden, not mfa_required', async () => {
    const res = await call('/api/v1/regulator/approvals', 'ana.operadora', 'password');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
  });

  it('the requirement follows the roles: granting data_steward requires the code next request', async () => {
    const elena = await prisma.user.findUniqueOrThrow({
      where: { keycloakSub: sub('elena.admin') },
    });
    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: elena.id, entityId: entity.salud },
    });
    const url = `/api/v1/entities/${entity.salud}/members`;
    expect((await call(url, 'elena.admin', 'password')).statusCode).toBe(200);
    try {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { roles: [...membership.roles, 'data_steward'] },
      });
      const res = await call(url, 'elena.admin', 'password');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'mfa_required' });
      expect((await call(url, 'elena.admin', 'mfa')).statusCode).toBe(200);
    } finally {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { roles: membership.roles },
      });
    }
  });
});
