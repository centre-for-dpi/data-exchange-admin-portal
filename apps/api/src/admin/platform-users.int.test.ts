import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { platformRoleHolderListSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { relinkIdentity } from './identity-relink.js';

/**
 * M-03: platform roles and account status from the operator console. Only a platform
 * administrator, with the second factor; every change audited with the administrator as actor.
 * The "last administrator" rule is checked against the unit fakes (the shared database may hold
 * other administrators); here the real SQL of the rule runs while another administrator exists.
 */
describe('platform roles and account status (M-03)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    await runSeed(prisma, audit, { config: loadCountryConfig({ code: 'co' }), realmUsers });
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (
    method: 'GET' | 'POST',
    url: string,
    who: { username?: string; sub?: string; email?: string },
    body?: unknown,
    acr: string | null = 'mfa',
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await issuer.token(who.sub ?? sub(who.username ?? ''), { acr, ...(who.email ? { email: who.email, name: 'Persona Nueva' } : {}) })}`,
      },
      ...(body === undefined ? {} : { payload: body as object }),
    });

  /** Someone who registered and signed in once, with no roles. */
  async function newPerson() {
    const id = randomUUID();
    const person = { sub: id, email: `rol.${id.slice(0, 8)}@example.org` };
    expect((await call('GET', '/me', person)).statusCode).toBe(200);
    return person;
  }

  const ADMIN = { username: 'pablo.plataforma' };
  const REASON = 'Designada por la resolución 12 de la AND';
  const events = (targetId: string) =>
    prisma.auditEvent.findMany({ where: { targetId }, orderBy: { seq: 'asc' } });

  it('answers 403 to every other role, and mfa_required without the second factor', async () => {
    const person = await newPerson();
    const body = { email: person.email, role: 'auditor', reason: REASON };
    const routes: Array<['GET' | 'POST', string, unknown?]> = [
      ['GET', '/admin/platform-roles'],
      ['POST', '/admin/platform-roles/grant', body],
      ['POST', '/admin/platform-roles/revoke', body],
      ['POST', '/admin/users/disable', { email: person.email, reason: REASON }],
      ['POST', '/admin/users/enable', { email: person.email, reason: REASON }],
    ];
    for (const [method, url, payload] of routes) {
      for (const who of [
        { username: 'ana.operadora' },
        { username: 'marta.regulador' },
        { username: 'sofia.auditora' },
        { username: 'elena.admin' },
        { username: 'carlos.dev' },
        person,
      ]) {
        const res = await call(method, url, who, payload);
        expect(
          res.statusCode,
          `${'username' in who ? who.username : 'new person'} ${method} ${url}`,
        ).toBe(403);
      }
      const noFactor = await call(method, url, ADMIN, payload, 'password');
      expect(noFactor.statusCode, `${method} ${url}`).toBe(403);
      expect(noFactor.json()).toMatchObject({ code: 'mfa_required' });
    }
    expect(await prisma.userPlatformRole.count({ where: { user: { email: person.email } } })).toBe(
      0,
    );
  });

  it('lists the holders', async () => {
    const res = await call('GET', '/admin/platform-roles', ADMIN);
    expect(res.statusCode).toBe(200);
    const list = platformRoleHolderListSchema.parse(res.json());
    expect(list.items.find((i) => i.email === 'pablo.plataforma@demo.den.example')?.role).toBe(
      'platform_admin',
    );
  });

  it('grants and revokes a role, audited with the administrator and the reason', async () => {
    const person = await newPerson();
    const grant = await call('POST', '/admin/platform-roles/grant', ADMIN, {
      email: person.email.toUpperCase(),
      role: 'regulator',
      reason: REASON,
    });
    expect(grant.statusCode, grant.body).toBe(200);
    expect(grant.json()).toEqual({ outcome: 'granted', email: person.email, role: 'regulator' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: person.email } });
    const role = await prisma.userPlatformRole.findFirstOrThrow({ where: { userId: user.id } });
    expect(role.grantedBy).toBe(sub('pablo.plataforma'));
    // Effective at once; the second factor is demanded from then on.
    expect(
      (await call('GET', '/regulator/approvals', person, undefined, 'password')).statusCode,
    ).toBe(403);
    expect((await call('GET', '/regulator/approvals', person)).statusCode).toBe(200);

    const again = await call('POST', '/admin/platform-roles/grant', ADMIN, {
      email: person.email,
      role: 'regulator',
      reason: REASON,
    });
    expect(again.json()).toMatchObject({ outcome: 'unchanged' });

    const revoke = await call('POST', '/admin/platform-roles/revoke', ADMIN, {
      email: person.email,
      role: 'regulator',
      reason: 'Dejó la comisión',
    });
    expect(revoke.json()).toMatchObject({ outcome: 'revoked' });
    expect((await call('GET', '/regulator/approvals', person)).statusCode).toBe(403);

    const trail = (await events(user.id)).filter((e) => e.action.startsWith('platform_role.'));
    expect(trail.map((e) => [e.action, e.actorType, e.actorId])).toEqual([
      ['platform_role.granted', 'user', sub('pablo.plataforma')],
      ['platform_role.revoked', 'user', sub('pablo.plataforma')],
    ]);
    expect(trail[0]?.after).toMatchObject({ role: 'regulator', reason: REASON });
  });

  it('lets an administrator go while another active one remains (the rule runs on the real tables)', async () => {
    const person = await newPerson();
    await call('POST', '/admin/platform-roles/grant', ADMIN, {
      email: person.email,
      role: 'platform_admin',
      reason: REASON,
    });
    const revoke = await call('POST', '/admin/platform-roles/revoke', ADMIN, {
      email: person.email,
      role: 'platform_admin',
      reason: 'Prueba de la regla del último administrador',
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const disable = await call('POST', '/admin/platform-roles/grant', ADMIN, {
      email: person.email,
      role: 'platform_admin',
      reason: REASON,
    });
    expect(disable.statusCode).toBe(200);
    const off = await call('POST', '/admin/users/disable', ADMIN, {
      email: person.email,
      reason: 'Prueba de la regla del último administrador',
    });
    expect(off.statusCode, off.body).toBe(200);
  });

  it('refuses what cannot be done: unknown account, disabled account, short reason, unknown role', async () => {
    const unknown = await call('POST', '/admin/platform-roles/grant', ADMIN, {
      email: 'nadie@example.org',
      role: 'auditor',
      reason: REASON,
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ errors: [{ path: 'email', key: 'unknown_account' }] });

    const person = await newPerson();
    await call('POST', '/admin/users/disable', ADMIN, { email: person.email, reason: REASON });
    const disabled = await call('POST', '/admin/platform-roles/grant', ADMIN, {
      email: person.email,
      role: 'auditor',
      reason: REASON,
    });
    expect(disabled.statusCode).toBe(409);

    for (const bad of [
      { email: person.email, role: 'auditor', reason: 'corto' },
      { email: person.email, role: 'entity_admin', reason: REASON },
      { email: 'no-es-correo', role: 'auditor', reason: REASON },
      { email: person.email, role: 'auditor', reason: REASON, extra: true },
    ]) {
      expect((await call('POST', '/admin/platform-roles/grant', ADMIN, bad)).statusCode).toBe(400);
    }
  });

  it('disables and enables an account: its requests answer 403 at once and come back', async () => {
    const person = await newPerson();
    const off = await call('POST', '/admin/users/disable', ADMIN, {
      email: person.email,
      reason: 'Cuenta comprometida, reportada por la entidad',
    });
    expect(off.json()).toMatchObject({ outcome: 'disabled', status: 'disabled' });
    expect((await call('GET', '/me', person)).statusCode).toBe(403);
    const again = await call('POST', '/admin/users/disable', ADMIN, {
      email: person.email,
      reason: 'Cuenta comprometida, reportada por la entidad',
    });
    expect(again.json()).toMatchObject({ outcome: 'unchanged' });

    const on = await call('POST', '/admin/users/enable', ADMIN, {
      email: person.email,
      reason: 'Falsa alarma, verificada con la entidad',
    });
    expect(on.json()).toMatchObject({ outcome: 'enabled', status: 'active' });
    expect((await call('GET', '/me', person)).statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: person.email } });
    expect((await events(user.id)).map((e) => e.action)).toEqual([
      'user.registered',
      'user.disabled',
      'user.enabled',
    ]);
  });

  it('re-links an account to a new identity and keeps its roles (B-22)', async () => {
    const person = await newPerson();
    await call('POST', '/admin/platform-roles/grant', ADMIN, {
      email: person.email,
      role: 'auditor',
      reason: REASON,
    });
    const newSub = randomUUID();
    const result = await relinkIdentity(prisma, audit, {
      email: person.email,
      newSub,
      reason: 'La persona perdió su usuario de Keycloak (oficio 77)',
    });
    expect(result.outcome).toBe('relinked');
    // The old identity no longer reaches the account; the new one gets its roles.
    expect((await call('GET', '/audit/events', person)).statusCode).toBe(409);
    const moved = await call('GET', '/audit/events', { sub: newSub, email: person.email });
    expect(moved.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: person.email } });
    const last = (await events(user.id)).at(-1);
    expect(last).toMatchObject({
      action: 'user.identity_relinked',
      actorId: 'cli:identity-relink',
    });
    expect(last?.before).toMatchObject({ keycloakSub: person.sub });
    expect(last?.after).toMatchObject({ keycloakSub: newSub });
  });
});
