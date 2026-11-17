import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { apiVersionDetailSchema, reviewDetailSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

describe('operator review and publication (M1-04)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: string | { sub: string },
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${await issuer.token(typeof who === 'string' ? subOf(who) : who.sub)}`,
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** pedro registers an API + version and submits it; returns the ids. */
  async function submitted(
    classification = 'personal',
    publisher: string | { sub: string } = 'pedro.publicador',
    exposedFields: Array<{ name: string; personal: boolean; sensitive: boolean }> = [],
  ) {
    const slug = `rev-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/api/v1/entities/${salud}/apis`, publisher, {
      slug,
      name: `Review ${slug}`,
      summary: 'API para probar la revisión del operador.',
      description: 'API de prueba con datos sintéticos.',
      sector: 'salud',
      classification,
      ownerContact: 'apis@salud.demo.rid.example',
    });
    expect(api.statusCode, api.body).toBe(201);
    const apiId = api.json<{ id: string }>().id;
    const version = await call(
      'POST',
      `/api/v1/entities/${salud}/apis/${apiId}/versions`,
      publisher,
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: ['eligibility_check'],
        exposedFields,
      },
    );
    const versionId = version.json<{ id: string }>().id;
    const submit = await call(
      'POST',
      `/api/v1/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      publisher,
    );
    expect(submit.statusCode, submit.body).toBe(200);
    return { apiId, versionId };
  }

  const review = (versionId: string, action = '') =>
    `/api/v1/review/api-versions/${versionId}${action}`;

  it('lists submitted versions in the review queue', async () => {
    const { versionId } = await submitted();
    // Oldest first, by pages (M6-11): walk them until the new version shows up.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call(
        'GET',
        `/api/v1/review/api-versions?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
        'ana.operadora',
      );
      expect(res.statusCode).toBe(200);
      const page = res.json<{ items: Array<{ versionId: string }>; nextCursor: string | null }>();
      expect(page.items.length).toBeLessThanOrEqual(100);
      seen.push(...page.items.map((i) => i.versionId));
      cursor = page.nextCursor;
    } while (cursor && !seen.includes(versionId));
    expect(seen).toContain(versionId);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('approving publishes the version, marks the API published, audits and enqueues the gateway sync', async () => {
    const { apiId, versionId } = await submitted();
    const res = await call('POST', review(versionId, '/approve'), 'ana.operadora', {
      comment: 'Ficha completa.',
    });
    expect(res.statusCode, res.body).toBe(200);
    const detail = reviewDetailSchema.parse(res.json());
    expect(detail.version.status).toBe('published');
    expect(detail.version.publishedAt).not.toBeNull();
    expect(detail.requiresRegulator).toBe(false);
    expect(detail.version.reviews).toMatchObject([
      { decision: 'approved', reviewerRole: 'platform_reviewer', comment: 'Ficha completa.' },
    ]);

    expect((await prisma.api.findUniqueOrThrow({ where: { id: apiId } })).status).toBe('published');
    const outbox = await prisma.outboxMessage.findMany({
      where: { aggregate: `apiVersion:${versionId}` },
    });
    expect(outbox.map((m) => m.topic)).toEqual(['gateway.sync']);
    const actions = (
      await prisma.auditEvent.findMany({ where: { targetId: versionId }, orderBy: { seq: 'asc' } })
    ).map((e) => e.action);
    expect(actions).toEqual([
      'api_version.created',
      'api_version.submitted',
      'api_version.approved',
      'api_version.published',
    ]);

    // A published version cannot be approved again.
    expect(
      (await call('POST', review(versionId, '/approve'), 'ana.operadora', {})).statusCode,
    ).toBe(409);
  });

  it('requesting changes needs a comment, the provider sees it, fixes and resubmits', async () => {
    const { apiId, versionId } = await submitted();
    expect(
      (
        await call('POST', review(versionId, '/request-changes'), 'ana.operadora', {
          comment: 'corto',
        })
      ).statusCode,
    ).toBe(400);

    const res = await call('POST', review(versionId, '/request-changes'), 'ana.operadora', {
      comment: 'Falta declarar el dato "estado" como personal.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ version: { status: 'changes_requested' } });

    const base = `/api/v1/entities/${salud}/apis/${apiId}/versions/${versionId}`;
    const seen = apiVersionDetailSchema.parse((await call('GET', base, 'pedro.publicador')).json());
    expect(seen.reviews).toMatchObject([
      { decision: 'changes_requested', comment: 'Falta declarar el dato "estado" como personal.' },
    ]);
    expect(
      await prisma.outboxMessage.count({ where: { aggregate: `apiVersion:${versionId}` } }),
    ).toBe(0);

    expect((await call('POST', `${base}/submit`, 'pedro.publicador')).statusCode).toBe(200);
    const approved = await call('POST', review(versionId, '/approve'), 'pablo.plataforma', {});
    expect(approved.json()).toMatchObject({ version: { status: 'published' } });
  });

  it('keeps sensitive versions waiting for the regulator, without publishing', async () => {
    const { versionId } = await submitted('sensitive');
    const res = await call('POST', review(versionId, '/approve'), 'ana.operadora', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      requiresRegulator: true,
      version: { status: 'approved_operator', publishedAt: null },
    });
    expect(
      await prisma.outboxMessage.count({ where: { aggregate: `apiVersion:${versionId}` } }),
    ).toBe(0);
  });

  it('rejects decisions on versions that are not in review', async () => {
    const slug = `draft-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/api/v1/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: slug,
      summary: 'Borrador sin enviar a revisión.',
      description: 'Prueba de transición.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@salud.demo.rid.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const draft = await call(
      'POST',
      `/api/v1/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: ['eligibility_check'],
      },
    );
    const res = await call(
      'POST',
      review(draft.json<{ id: string }>().id, '/approve'),
      'ana.operadora',
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'invalid_transition' });
    expect((await call('GET', review(randomUUID()), 'ana.operadora')).statusCode).toBe(404);
  });

  it('requires the regulator when a non-sensitive API declares a sensitive exposed field', async () => {
    const { versionId } = await submitted('personal', 'pedro.publicador', [
      { name: 'diagnostico', personal: true, sensitive: true },
    ]);
    const res = await call('POST', review(versionId, '/approve'), 'ana.operadora', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      requiresRegulator: true,
      version: { status: 'approved_operator', publishedAt: null },
    });
    expect(
      await prisma.outboxMessage.count({ where: { aggregate: `apiVersion:${versionId}` } }),
    ).toBe(0);
  });

  describe('conflict of interest (security review follow-up)', () => {
    /** A user with an operator role and, optionally, a membership in the provider entity. */
    async function operatorUser(membershipRoles?: Array<'api_publisher' | 'entity_viewer'>) {
      const sub = randomUUID();
      const user = await prisma.user.create({
        data: {
          keycloakSub: sub,
          email: `coi.${sub.slice(0, 8)}@example.org`,
          fullName: 'Conflicted reviewer',
          createdBy: 'system:test',
        },
      });
      await prisma.userPlatformRole.create({
        data: { userId: user.id, role: 'platform_reviewer', grantedBy: 'system:test' },
      });
      const membership = membershipRoles
        ? await prisma.membership.create({
            data: {
              userId: user.id,
              entityId: salud,
              roles: membershipRoles,
              status: 'active',
              createdBy: 'system:test',
            },
          })
        : undefined;
      return { sub, membershipId: membership?.id };
    }

    it('a reviewer who belongs to the provider entity cannot decide, even without submitting', async () => {
      const { sub } = await operatorUser(['entity_viewer']);
      const { versionId } = await submitted();
      const approve = await call('POST', review(versionId, '/approve'), { sub }, {});
      expect(approve.statusCode).toBe(403);
      expect(approve.json<{ detail: string }>().detail).toMatch(/entity you belong to/);
      const changes = await call(
        'POST',
        review(versionId, '/request-changes'),
        { sub },
        {
          comment: 'Comentario suficientemente largo.',
        },
      );
      expect(changes.statusCode).toBe(403);
    });

    it('the author cannot approve even after leaving the entity', async () => {
      const { sub, membershipId } = await operatorUser(['api_publisher']);
      const { versionId } = await submitted('personal', { sub });
      await prisma.membership.update({
        where: { id: membershipId ?? '' },
        data: { status: 'revoked' },
      });
      const res = await call('POST', review(versionId, '/approve'), { sub }, {});
      expect(res.statusCode).toBe(403);
      expect(res.json<{ detail: string }>().detail).toMatch(/created or submitted/);
    });
  });

  describe('authorization', () => {
    let versionId = '';
    beforeAll(async () => {
      versionId = (await submitted()).versionId;
    });

    it('lets operator staff and the regulator read the queue and the service sheet, nobody else', async () => {
      for (const user of ['ana.operadora', 'pablo.plataforma', 'marta.regulador']) {
        expect((await call('GET', '/api/v1/review/api-versions', user)).statusCode, user).toBe(200);
        expect((await call('GET', review(versionId), user)).statusCode, user).toBe(200);
      }
      for (const user of ['pedro.publicador', 'lucia.datos', 'carlos.dev', 'sofia.auditora']) {
        expect((await call('GET', '/api/v1/review/api-versions', user)).statusCode, user).toBe(403);
        expect((await call('GET', review(versionId), user)).statusCode, user).toBe(403);
      }
    });

    it('lets only operator staff decide (the regulator step is M2-04)', async () => {
      for (const user of [
        'marta.regulador',
        'pedro.publicador',
        'elena.admin',
        'carlos.dev',
        'sofia.auditora',
      ]) {
        expect((await call('POST', review(versionId, '/approve'), user, {})).statusCode, user).toBe(
          403,
        );
        expect(
          (
            await call('POST', review(versionId, '/request-changes'), user, {
              comment: 'Comentario suficiente.',
            })
          ).statusCode,
          user,
        ).toBe(403);
      }
    });

    it('enforces separation of duties: whoever submitted cannot approve', async () => {
      // A user who is both an API publisher at the entity and an operator reviewer.
      const sub = randomUUID();
      const user = await prisma.user.create({
        data: {
          keycloakSub: sub,
          email: `dual.${sub.slice(0, 8)}@example.org`,
          fullName: 'Dual role',
          createdBy: 'system:test',
        },
      });
      await prisma.membership.create({
        data: {
          userId: user.id,
          entityId: salud,
          roles: ['api_publisher'],
          status: 'active',
          createdBy: 'system:test',
        },
      });
      await prisma.userPlatformRole.create({
        data: { userId: user.id, role: 'platform_reviewer', grantedBy: 'system:test' },
      });

      const { versionId: own } = await submitted('personal', { sub });
      const res = await call('POST', review(own, '/approve'), { sub }, {});
      expect(res.statusCode).toBe(403);
      expect(res.json<{ detail: string }>().detail).toMatch(/submitted/);
      expect((await call('POST', review(own, '/approve'), 'ana.operadora', {})).statusCode).toBe(
        200,
      );
    });
  });
});
