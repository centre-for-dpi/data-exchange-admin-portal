import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  bootcampChecklistSchema,
  type EntityRole,
  networkBootcampSchema,
  type PlatformRole,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { MAIL_TRANSPORT } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface Person {
  sub: string;
  email: string;
  userId: string;
}

describe('bootcamp readiness checklist (M4-07)', () => {
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

  const call = async (method: 'GET' | 'PUT', url: string, who: Person, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await issuer.token(who.sub, { email: who.email, name: who.email, emailVerified: true })}`,
      },
      ...(payload ? { payload } : {}),
    });

  async function person(label: string): Promise<Person> {
    const who = { sub: randomUUID(), email: `${label}.${randomUUID().slice(0, 8)}@example.org` };
    await call('GET', '/me', { ...who, userId: '' });
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
  async function entity() {
    const id = randomUUID().slice(0, 8);
    return (
      await prisma.entity.create({
        data: {
          legalName: `Entidad bootcamp ${id}`,
          shortName: `B ${id}`,
          slug: `bootcamp-${id}`,
          taxIdType: 'NIT',
          taxId: `2${id}`,
          kind: 'territorial',
          sector: 'salud',
          status: 'active',
          contactEmail: `c.${id}@example.org`,
          dpoName: 'Dora',
          dpoEmail: `d.${id}@example.org`,
          createdBy: 'test',
        },
      })
    ).id;
  }

  it('starts pending; the admin confirms items; designees come from the members', async () => {
    const entityId = await entity();
    const admin = await member(entityId, ['entity_admin']);
    const initial = bootcampChecklistSchema.parse(
      (await call('GET', `/entities/${entityId}/bootcamp`, admin)).json(),
    );
    expect(initial.ready).toBe(false);
    expect(initial.items.map((i) => [i.item, i.status, i.automatic])).toEqual([
      ['server', 'pending', false],
      ['readonly_user', 'pending', false],
      ['outbound_443', 'pending', false],
      ['designees', 'pending', true],
      ['use_case', 'pending', false],
    ]);

    for (const item of ['server', 'readonly_user', 'outbound_443', 'use_case']) {
      const res = await call('PUT', `/entities/${entityId}/bootcamp/${item}`, admin, {
        status: 'done',
        ...(item === 'use_case' ? { note: 'Verificar afiliación al asignar subsidios' } : {}),
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    let list = bootcampChecklistSchema.parse(
      (await call('GET', `/entities/${entityId}/bootcamp`, admin)).json(),
    );
    expect(list.ready).toBe(false);
    expect(list.items.find((i) => i.item === 'use_case')?.note).toBe(
      'Verificar afiliación al asignar subsidios',
    );

    // A publisher and a data steward: the designees item is done by itself.
    await member(entityId, ['api_publisher']);
    await member(entityId, ['data_steward']);
    list = bootcampChecklistSchema.parse(
      (await call('GET', `/entities/${entityId}/bootcamp`, admin)).json(),
    );
    expect(list.ready).toBe(true);

    // The automatic item cannot be set by hand.
    expect(
      (await call('PUT', `/entities/${entityId}/bootcamp/designees`, admin, { status: 'done' }))
        .statusCode,
    ).toBe(404);
    const events = await prisma.auditEvent.findMany({
      where: { targetId: entityId, action: 'bootcamp.item_updated' },
    });
    expect(events).toHaveLength(4);
  });

  it('the use case counts the manual steps it avoids; no other item does (M5-04)', async () => {
    const entityId = await entity();
    const admin = await member(entityId, ['entity_admin']);
    const res = await call('PUT', `/entities/${entityId}/bootcamp/use_case`, admin, {
      status: 'done',
      note: 'Certificado de afiliación para subsidios',
      manualStepsAvoided: 3,
    });
    expect(res.statusCode, res.body).toBe(200);
    const list = bootcampChecklistSchema.parse(res.json());
    expect(list.items.find((i) => i.item === 'use_case')?.manualStepsAvoided).toBe(3);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: entityId, action: 'bootcamp.item_updated' },
    });
    expect(event.after).toMatchObject({ item: 'use_case', manualStepsAvoided: 3 });

    const server = await call('PUT', `/entities/${entityId}/bootcamp/server`, admin, {
      status: 'done',
      manualStepsAvoided: 2,
    });
    expect(server.statusCode).toBe(400);
    const negative = await call('PUT', `/entities/${entityId}/bootcamp/use_case`, admin, {
      status: 'done',
      manualStepsAvoided: -1,
    });
    expect(negative.statusCode).toBe(400);
  });

  it('only the entity admin and the operator confirm; the operator sees every entity', async () => {
    const entityId = await entity();
    const viewer = await member(entityId, ['entity_viewer']);
    const operator = await platform('platform_admin');
    const reviewer = await platform('platform_reviewer');
    const outsider = await member(await entity(), ['entity_admin']);
    const put = (who: Person) =>
      call('PUT', `/entities/${entityId}/bootcamp/server`, who, { status: 'done' });

    expect((await call('GET', `/entities/${entityId}/bootcamp`, viewer)).statusCode).toBe(200);
    expect((await put(viewer)).statusCode).toBe(403);
    expect((await put(outsider)).statusCode).toBe(404);
    expect((await put(operator)).statusCode).toBe(200);

    const res = await call('GET', '/admin/bootcamp', reviewer);
    expect(res.statusCode).toBe(200);
    const row = networkBootcampSchema.parse(res.json()).items.find((i) => i.entity.id === entityId);
    expect(row).toMatchObject({ done: 1, total: 5 });
    expect((await call('GET', '/admin/bootcamp', viewer)).statusCode).toBe(403);
  });
});
