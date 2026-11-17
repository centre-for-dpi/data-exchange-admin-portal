import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  adminEntityListSchema,
  adminEntitySchema,
  createdApplicationSchema,
  type EntityRole,
  subscriptionDetailSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { OpaService } from '../opa/opa.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

interface Person {
  sub: string;
  email: string;
}

describe('suspension and offboarding of entities (M2-11)', () => {
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

  const token = (who: string | Person) =>
    typeof who === 'string'
      ? issuer.token(subOf(who))
      : issuer.token(who.sub, { email: who.email, emailVerified: true });
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    who: string | Person,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await token(who)}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function member(entityId: string, roles: EntityRole[]): Promise<Person> {
    const p = { sub: randomUUID(), email: `m211.${randomUUID().slice(0, 8)}@example.org` };
    await call('GET', '/me', p);
    const user = await prisma.user.findUniqueOrThrow({ where: { keycloakSub: p.sub } });
    await prisma.membership.create({
      data: { userId: user.id, entityId, roles, status: 'active', createdBy: 'test' },
    });
    return p;
  }

  /** A fresh active entity with an admin, a publisher, a developer and a steward. */
  async function entity() {
    const id = randomUUID().slice(0, 8);
    const row = await prisma.entity.create({
      data: {
        legalName: `Entidad ${id}`,
        shortName: `E ${id}`,
        slug: `e211-${id}`,
        taxIdType: 'NIT',
        taxId: `6${id}`,
        kind: 'national',
        sector: 'salud',
        status: 'active',
        contactEmail: `c.${id}@example.org`,
        dpoName: 'Dora',
        dpoEmail: `d.${id}@example.org`,
        createdBy: 'test',
      },
    });
    return {
      id: row.id,
      admin: await member(row.id, ['entity_admin']),
      publisher: await member(row.id, ['api_publisher']),
      developer: await member(row.id, ['app_developer']),
      steward: await member(row.id, ['data_steward']),
    };
  }

  async function publishedApi(entityId: string, publisher: string | Person) {
    const slug = `s211-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/entities/${entityId}/apis`, publisher, {
      slug,
      name: `M211 ${slug}`,
      summary: 'API para probar la suspensión de entidades.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@example.org',
    });
    expect(api.statusCode, api.body).toBe(201);
    const apiId = api.json<{ id: string }>().id;
    const v = await call('POST', `/entities/${entityId}/apis/${apiId}/versions`, publisher, {
      version: '1.0',
      openapi,
      upstream: { type: 'node', servicePath: '/salud' },
      allowedPurposes: ['eligibility_check'],
      exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
    });
    const versionId = v.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${entityId}/apis/${apiId}/versions/${versionId}/submit`,
      publisher,
    );
    expect(
      (await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {}))
        .statusCode,
    ).toBe(200);
    return { apiId, versionId };
  }

  /** `developer` of `consumer` holds an approved subscription to `versionId`. */
  async function subscription(
    consumer: string,
    developer: Person,
    versionId: string,
    steward: string | Person,
  ) {
    const created = await call('POST', `/entities/${consumer}/applications`, developer, {
      name: `App ${randomUUID().slice(0, 6)}`,
      description: 'Aplicación de prueba de la suspensión.',
      environment: 'production',
      technicalContact: 'dev@example.org',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const res = await call('POST', `/entities/${consumer}/subscriptions`, developer, {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar un subsidio.',
      legalBasisText: 'Ley de protección de datos, artículo 10.',
      validityMonths: 12,
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = subscriptionDetailSchema.parse(res.json()).id;
    const provider = (
      await prisma.subscription.findUniqueOrThrow({
        where: { id },
        include: { apiVersion: { include: { api: true } } },
      })
    ).apiVersion.api.entityId;
    expect(
      (await call('POST', `/entities/${provider}/access-requests/${id}/approve`, steward, {}))
        .statusCode,
    ).toBe(200);
    return { id, applicationId };
  }

  const bundle = () => app.get(OpaService).data();

  it('suspending a consumer suspends its applications at the gateway and blocks new requests', async () => {
    const consumer = await entity();
    const salesVersion = (await publishedApi(salud, 'pedro.publicador')).versionId;
    const { applicationId } = await subscription(
      consumer.id,
      consumer.developer,
      salesVersion,
      'lucia.datos',
    );
    const clientOf = async () =>
      Object.values((await bundle()).data.clients).find((c) => c.applicationId === applicationId);
    expect((await clientOf())?.status).toBe('active');

    const res = await call('POST', `/admin/entities/${consumer.id}/suspend`, 'pablo.plataforma', {
      comment: 'Incumplimiento del acuerdo marco.',
    });
    expect(res.statusCode, res.body).toBe(200);
    // The decision answers with the entity (M6-11), not the whole list.
    expect(adminEntitySchema.parse(res.json())).toMatchObject({
      id: consumer.id,
      status: 'suspended',
      providerSuspended: false,
    });
    expect((await clientOf())?.status).toBe('suspended');
    const again = await call('POST', `/entities/${consumer.id}/subscriptions`, consumer.developer, {
      applicationId,
      apiVersionId: salesVersion,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Otra solicitud mientras está suspendida.',
      legalBasisText: 'Ley de protección de datos, artículo 10.',
      validityMonths: 6,
    });
    expect(again.statusCode).toBe(409);
    expect(
      await prisma.outboxMessage.count({ where: { aggregate: `entity:${consumer.id}` } }),
    ).toBeGreaterThan(0);

    expect(
      (await call('POST', `/admin/entities/${consumer.id}/reactivate`, 'pablo.plataforma', {}))
        .statusCode,
    ).toBe(200);
    expect((await clientOf())?.status).toBe('active');
    expect(
      (
        await prisma.auditEvent.findMany({
          where: { targetId: consumer.id },
          orderBy: { seq: 'asc' },
        })
      ).map((e) => e.action),
    ).toEqual(['entity.suspended', 'entity.reactivated']);
  });

  it('a suspension also as provider stops serving its APIs, and blocks its publications', async () => {
    const provider = await entity();
    const { versionId } = await publishedApi(provider.id, provider.publisher);
    const consumer = await entity();
    const { id } = await subscription(consumer.id, consumer.developer, versionId, provider.steward);
    const served = async () =>
      Object.values((await bundle()).data.clients).some((c) =>
        c.subscriptions.some((s) => s.id === id),
      );
    expect(await served()).toBe(true);

    await call('POST', `/admin/entities/${provider.id}/suspend`, 'pablo.plataforma', {
      comment: 'Fuga de datos en investigación.',
      alsoAsProvider: true,
    });
    expect(await served()).toBe(false);
    const create = await call('POST', `/entities/${provider.id}/apis`, provider.publisher, {
      slug: `nueva-${randomUUID().slice(0, 6)}`,
      name: 'Nueva API',
      summary: 'No debería poder crearse.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@example.org',
    });
    expect(create.statusCode).toBe(409);
    await call('POST', `/admin/entities/${provider.id}/reactivate`, 'pablo.plataforma', {});
    expect(await served()).toBe(true);
  });

  it('offboarding closes subscriptions on both sides, retires versions and revokes members', async () => {
    const provider = await entity();
    const { versionId } = await publishedApi(provider.id, provider.publisher);
    const consumer = await entity();
    const provided = await subscription(
      consumer.id,
      consumer.developer,
      versionId,
      provider.steward,
    );
    const consumed = await subscription(
      provider.id,
      provider.developer,
      (await publishedApi(salud, 'pedro.publicador')).versionId,
      'lucia.datos',
    );

    const res = await call('POST', `/admin/entities/${provider.id}/offboard`, 'pablo.plataforma', {
      comment: 'La entidad fue liquidada por ley.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: provided.id } })).status,
    ).toBe('revoked');
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: consumed.id } })).status,
    ).toBe('revoked');
    expect((await prisma.apiVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe(
      'retired',
    );
    expect(
      await prisma.membership.count({ where: { entityId: provider.id, status: 'active' } }),
    ).toBe(0);
    // Its people lose access at once.
    expect((await call('GET', `/entities/${provider.id}`, provider.admin)).statusCode).toBe(404);
    // Final.
    expect(
      (await call('POST', `/admin/entities/${provider.id}/reactivate`, 'pablo.plataforma', {}))
        .statusCode,
    ).toBe(409);
  });

  it('only the platform admin decides; reviewers and the regulator only read', async () => {
    const target = await entity();
    for (const who of ['ana.operadora', 'marta.regulador', 'sofia.auditora']) {
      expect(
        (
          await call('POST', `/admin/entities/${target.id}/suspend`, who, {
            comment: 'No me corresponde decidir.',
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await call('POST', `/admin/entities/${target.id}/suspend`, target.admin, {
          comment: 'No me corresponde decidir.',
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('GET', '/admin/entities?status=active', 'marta.regulador')).statusCode).toBe(
      200,
    );
    expect((await call('GET', '/admin/entities', 'lucia.datos')).statusCode).toBe(403);
    // By pages, with a search (M6-11): the entity is found by its identifier however many there are.
    const { slug } = await prisma.entity.findUniqueOrThrow({ where: { id: target.id } });
    const found = adminEntityListSchema.parse(
      (await call('GET', `/admin/entities?q=${slug}&limit=5`, 'marta.regulador')).json(),
    );
    expect(found.items.map((e) => e.id)).toContain(target.id);
    const first = adminEntityListSchema.parse(
      (await call('GET', '/admin/entities?limit=2', 'marta.regulador')).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);
    const second = adminEntityListSchema.parse(
      (
        await call('GET', `/admin/entities?limit=2&cursor=${first.nextCursor}`, 'marta.regulador')
      ).json(),
    );
    expect(second.items.map((e) => e.id)).not.toContain(first.items[0]?.id);
    expect(second.items.map((e) => e.id)).not.toContain(first.items[1]?.id);
  });

  it('the platform admin registers an entity directly: active, its admin and designees invited', async () => {
    const id = randomUUID().slice(0, 8);
    const adminEmail = `admin.${id}@example.org`;
    const stewardEmail = `datos.${id}@example.org`;
    const body = {
      legalName: `Instituto Directo ${id}`,
      shortName: `Directo ${id}`,
      slug: `directo-${id}`,
      taxIdType: 'NIT',
      taxId: `7${id}`,
      kind: 'national',
      sector: 'salud',
      contactEmail: `contacto.${id}@example.org`,
      dpoName: 'Diana Datos',
      dpoEmail: `dpo.${id}@example.org`,
      designees: {
        data_steward: { fullName: 'Lina Datos', email: stewardEmail },
        // The technical lead is the admin too: one invitation with both sets of roles.
        technical_lead: { fullName: 'Tomás Técnico', email: adminEmail },
      },
      admin: { fullName: 'Andrea Admin', email: adminEmail },
      basis: 'Decreto 123 de 2026, artículo 4: incorporación a la red.',
    };
    for (const who of ['ana.operadora', 'marta.regulador', 'lucia.datos']) {
      expect((await call('POST', '/admin/entities', who, body)).statusCode).toBe(403);
    }
    const res = await call('POST', '/admin/entities', 'pablo.plataforma', body);
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{ id: string; status: string }>();
    expect(created.status).toBe('active');

    const invitations = await prisma.invitation.findMany({
      where: { entityId: created.id },
      orderBy: { email: 'asc' },
    });
    expect(invitations.map((i) => [i.email, [...i.roles].sort()])).toEqual([
      [adminEmail, ['api_publisher', 'app_developer', 'entity_admin']],
      [stewardEmail, ['data_steward']],
    ]);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: created.id, action: 'entity.created' },
    });
    expect(audit.after).toMatchObject({ via: 'operator', basis: body.basis, status: 'active' });

    // The invited admin accepts and administers it.
    const admin = { sub: randomUUID(), email: adminEmail };
    const invitation = invitations.find((i) => i.email === adminEmail);
    const accept = await call('POST', `/me/invitations/${invitation?.id ?? ''}/accept`, admin);
    expect(accept.statusCode, accept.body).toBe(200);
    expect((await call('GET', `/entities/${created.id}/members`, admin)).statusCode).toBe(200);

    // The identifier and tax id are now taken; the operator cannot name themselves.
    const again = await call('POST', '/admin/entities', 'pablo.plataforma', body);
    expect(again.statusCode).toBe(400);
    expect(JSON.stringify(again.json())).toContain('slug');
    const pablo = realmUsers.find((u) => u.username === 'pablo.plataforma');
    const self = await call('POST', '/admin/entities', 'pablo.plataforma', {
      ...body,
      slug: `otro-${id}`,
      taxId: `8${id}`,
      admin: { fullName: 'Pablo', email: pablo?.email ?? '' },
    });
    expect(self.statusCode).toBe(400);
    expect(JSON.stringify(self.json())).toContain('admin.email');
    // Nor as a designee: that would also give them roles in the entity.
    const designee = await call('POST', '/admin/entities', 'pablo.plataforma', {
      ...body,
      slug: `otro-${id}`,
      taxId: `8${id}`,
      designees: {
        ...body.designees,
        data_steward: { fullName: 'Pablo', email: pablo?.email ?? '' },
      },
    });
    expect(designee.statusCode).toBe(400);
    expect(JSON.stringify(designee.json())).toContain('designees.data_steward.email');
  });
});
