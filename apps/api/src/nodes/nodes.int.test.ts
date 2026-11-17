import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type EntityRole,
  issuedEnrollmentTokenSchema,
  networkNodeListSchema,
  nodeDetailSchema,
  nodeListSchema,
  type PlatformRole,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { hashSecret } from '../common/secrets.js';
import { MAIL_TRANSPORT } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ENROLLMENT_TOKEN_PREFIX } from './nodes.service.js';

interface Person {
  sub: string;
  email: string;
}

describe('nodes and enrollment tokens (M4-01)', () => {
  const prisma = new PrismaService();
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      { token: MAIL_TRANSPORT, value: { send: () => Promise.resolve() } },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (method: 'GET' | 'POST', url: string, who: Person, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await issuer.token(who.sub, { email: who.email, name: who.email, emailVerified: true })}`,
      },
      ...(payload ? { payload } : method === 'POST' ? { payload: {} } : {}),
    });

  async function person(label: string): Promise<Person & { userId: string }> {
    const who = { sub: randomUUID(), email: `${label}.${randomUUID().slice(0, 8)}@example.org` };
    expect((await call('GET', '/me', who)).statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { keycloakSub: who.sub } });
    return { ...who, userId: user.id };
  }

  async function member(entityId: string, roles: EntityRole[]) {
    const who = await person(roles.join('-'));
    await prisma.membership.create({
      data: { userId: who.userId, entityId, roles, status: 'active', createdBy: 'test' },
    });
    return who;
  }

  async function platform(role: PlatformRole) {
    const who = await person(role);
    await prisma.userPlatformRole.create({ data: { userId: who.userId, role, grantedBy: 'test' } });
    return who;
  }

  async function entity(status: 'active' | 'suspended' = 'active') {
    const id = randomUUID().slice(0, 8);
    const row = await prisma.entity.create({
      data: {
        legalName: `Entidad nodos ${id}`,
        shortName: `N ${id}`,
        slug: `nodos-${id}`,
        taxIdType: 'NIT',
        taxId: `6${id}`,
        kind: 'national',
        sector: 'salud',
        status,
        contactEmail: `c.${id}@example.org`,
        dpoName: 'Dora',
        dpoEmail: `d.${id}@example.org`,
        createdBy: 'test',
      },
    });
    return row.id;
  }

  const audited = (nodeId: string) =>
    prisma.auditEvent.findMany({ where: { targetId: nodeId }, orderBy: { seq: 'asc' } });

  it('the entity admin registers a node and gets its token once; only the hash is kept', async () => {
    const entityId = await entity();
    const admin = await member(entityId, ['entity_admin']);
    const res = await call('POST', `/entities/${entityId}/nodes`, admin, {
      name: 'servidor-principal',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const issued = issuedEnrollmentTokenSchema.parse(res.json());
    expect(issued.token.startsWith(ENROLLMENT_TOKEN_PREFIX)).toBe(true);
    expect(issued.node).toMatchObject({
      name: 'servidor-principal',
      status: 'enrollment_issued',
      enrollmentToken: { status: 'active' },
    });
    // Valid for 72 hours (SPEC.md §4.6).
    const hours = (new Date(issued.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);

    const stored = await prisma.nodeEnrollmentToken.findFirstOrThrow({
      where: { nodeId: issued.node.id },
    });
    expect(stored.tokenHash).toBe(hashSecret(issued.token));
    // Listing and reading the node never show the token again.
    const listed = await call('GET', `/entities/${entityId}/nodes`, admin);
    expect(nodeListSchema.parse(listed.json()).items.map((n) => n.id)).toContain(issued.node.id);
    expect(listed.body).not.toContain(issued.token);
    const detail = await call('GET', `/entities/${entityId}/nodes/${issued.node.id}`, admin);
    expect(detail.body).not.toContain(issued.token);
    expect(detail.body).not.toContain(stored.tokenHash);

    const events = await audited(issued.node.id);
    expect(events.map((e) => e.action)).toEqual(['node.created', 'node.enrollment_token_issued']);
    expect(events[1]?.actorEntityId).toBe(entityId);
    const trail = JSON.stringify(events.map((e) => [e.before, e.after]));
    expect(trail).not.toContain(issued.token);
    expect(trail).not.toContain(stored.tokenHash);
  });

  it('names are unique per entity', async () => {
    const entityId = await entity();
    const admin = await member(entityId, ['entity_admin']);
    const first = await call('POST', `/entities/${entityId}/nodes`, admin, { name: 'nodo-1' });
    expect(first.statusCode).toBe(201);
    const again = await call('POST', `/entities/${entityId}/nodes`, admin, { name: 'nodo-1' });
    expect(again.statusCode).toBe(409);
    // Another entity may use the same name.
    const otherId = await entity();
    const otherAdmin = await member(otherId, ['entity_admin']);
    const other = await call('POST', `/entities/${otherId}/nodes`, otherAdmin, { name: 'nodo-1' });
    expect(other.statusCode).toBe(201);
  });

  it('a new token revokes the one still active; tokens can be revoked once', async () => {
    const entityId = await entity();
    const admin = await member(entityId, ['entity_admin']);
    const created = issuedEnrollmentTokenSchema.parse(
      (await call('POST', `/entities/${entityId}/nodes`, admin, { name: 'nodo-rotado' })).json(),
    );
    const nodeId = created.node.id;
    const firstTokenId = created.node.enrollmentToken?.id ?? '';

    const reissued = await call(
      'POST',
      `/entities/${entityId}/nodes/${nodeId}/enrollment-tokens`,
      admin,
    );
    expect(reissued.statusCode, reissued.body).toBe(201);
    const second = issuedEnrollmentTokenSchema.parse(reissued.json());
    expect(second.token).not.toBe(created.token);

    const detail = nodeDetailSchema.parse(
      (await call('GET', `/entities/${entityId}/nodes/${nodeId}`, admin)).json(),
    );
    expect(detail.enrollmentTokens.map((t) => [t.id === firstTokenId, t.status])).toEqual([
      [false, 'active'],
      [true, 'revoked'],
    ]);

    const tokenId = second.node.enrollmentToken?.id ?? '';
    const revoke = `/entities/${entityId}/nodes/${nodeId}/enrollment-tokens/${tokenId}/revoke`;
    const revoked = await call('POST', revoke, admin);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(nodeDetailSchema.parse(revoked.json()).enrollmentToken?.status).toBe('revoked');
    expect((await call('POST', revoke, admin)).statusCode).toBe(409);

    const actions = (await audited(nodeId)).map((e) => [
      e.action,
      (e.after as { reason?: string })?.reason,
    ]);
    expect(actions).toEqual([
      ['node.created', undefined],
      ['node.enrollment_token_issued', undefined],
      ['node.enrollment_token_revoked', 'superseded'],
      ['node.enrollment_token_issued', undefined],
      ['node.enrollment_token_revoked', 'revoked'],
    ]);
  });

  it('shows a token past its 72 hours as expired, and an enrolled node needs no new token', async () => {
    const entityId = await entity();
    const admin = await member(entityId, ['entity_admin']);
    const created = issuedEnrollmentTokenSchema.parse(
      (await call('POST', `/entities/${entityId}/nodes`, admin, { name: 'nodo-viejo' })).json(),
    );
    await prisma.nodeEnrollmentToken.updateMany({
      where: { nodeId: created.node.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const listed = nodeListSchema.parse(
      (await call('GET', `/entities/${entityId}/nodes`, admin)).json(),
    );
    expect(listed.items.find((n) => n.id === created.node.id)?.enrollmentToken?.status).toBe(
      'expired',
    );

    await prisma.node.updateMany({ where: { id: created.node.id }, data: { status: 'enrolled' } });
    const res = await call(
      'POST',
      `/entities/${entityId}/nodes/${created.node.id}/enrollment-tokens`,
      admin,
    );
    expect(res.statusCode).toBe(409);
  });

  it('a suspended entity cannot register nodes', async () => {
    const entityId = await entity('suspended');
    const admin = await member(entityId, ['entity_admin']);
    const res = await call('POST', `/entities/${entityId}/nodes`, admin, { name: 'nodo-x' });
    expect(res.statusCode).toBe(409);
  });

  it('only the entity admin and the operator issue tokens; members read, others get 403/404', async () => {
    const entityId = await entity();
    const publisher = await member(entityId, ['api_publisher']);
    const operator = await platform('platform_admin');
    const reviewer = await platform('platform_reviewer');
    const outsider = await member(await entity(), ['entity_admin']);

    expect(
      (await call('POST', `/entities/${entityId}/nodes`, publisher, { name: 'nodo-p' })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/entities/${entityId}/nodes`, reviewer, { name: 'nodo-r' })).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `/entities/${entityId}/nodes`, outsider, { name: 'nodo-o' })).statusCode,
    ).toBe(404);
    expect((await call('GET', `/entities/${entityId}/nodes`, outsider)).statusCode).toBe(404);

    // The operator issues tokens for an entity at the bootcamp (SPEC.md §4.6 step 1).
    const byOperator = await call('POST', `/entities/${entityId}/nodes`, operator, {
      name: 'nodo-bootcamp',
    });
    expect(byOperator.statusCode, byOperator.body).toBe(201);
    expect((await call('GET', `/entities/${entityId}/nodes`, publisher)).statusCode).toBe(200);
    expect((await call('GET', `/entities/${entityId}/nodes`, reviewer)).statusCode).toBe(200);
  });

  it('the operator console lists every node of the network with its entity', async () => {
    const entityId = await entity();
    const admin = await member(entityId, ['entity_admin']);
    const created = issuedEnrollmentTokenSchema.parse(
      (await call('POST', `/entities/${entityId}/nodes`, admin, { name: 'nodo-red' })).json(),
    );
    const regulator = await platform('regulator');
    const res = await call('GET', '/admin/nodes', regulator);
    expect(res.statusCode).toBe(200);
    const row = networkNodeListSchema.parse(res.json()).items.find((n) => n.id === created.node.id);
    expect(row?.entity.id).toBe(entityId);
    expect(res.body).not.toContain(created.token);
    expect((await call('GET', '/admin/nodes', admin)).statusCode).toBe(403);
  });
});
