import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { apiDetailSchema, apiVersionDetailSchema } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

const saludOpenapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

describe('API registration (M1-03)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const request = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    username: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await issuer.token(sub(username))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const apiBody = (slug: string) => ({
    slug,
    name: 'Consulta de afiliación',
    summary: 'Consulta el estado de afiliación de una persona.',
    description: 'API de prueba con datos sintéticos para la demo del hito M1.',
    sector: 'salud',
    tags: ['afiliacion'],
    classification: 'personal',
    ownerContact: 'apis@salud.demo.den.example',
  });

  const versionBody = (openapi = saludOpenapi, version = '1.0') => ({
    version,
    openapi,
    upstream: { type: 'node', servicePath: '/salud' },
    exposedFields: [
      { name: 'regimen', personal: true, sensitive: false },
      { name: 'estado', personal: true, sensitive: false },
    ],
    allowedPurposes: ['eligibility_check'],
    legalBasisText: 'Base legal de prueba.',
  });

  const createApi = async (slug = `afiliacion-${run}-${randomUUID().slice(0, 4)}`) => {
    const res = await request(
      'POST',
      `/api/v1/entities/${salud}/apis`,
      'pedro.publicador',
      apiBody(slug),
    );
    expect(res.statusCode, res.body).toBe(201);
    return apiDetailSchema.parse(res.json());
  };

  describe('versions on kit nodes (M4-04)', () => {
    const nodeOf = async (entityId: string, status: 'enrolled' | 'decommissioned') =>
      prisma.node.create({
        data: { entityId, name: `nodo-${randomUUID().slice(0, 8)}`, status, createdBy: 'test' },
      });
    const register = async (apiId: string, nodeId: string) =>
      request('POST', `/api/v1/entities/${salud}/apis/${apiId}/versions`, 'pedro.publicador', {
        ...versionBody(),
        upstream: { type: 'node', nodeId, servicePath: '/salud' },
      });

    it('serves a version on a node of the entity, and shows the node', async () => {
      const node = await nodeOf(salud, 'enrolled');
      const api = await createApi();
      const res = await register(api.id, node.id);
      expect(res.statusCode, res.body).toBe(201);
      expect(apiVersionDetailSchema.parse(res.json()).node).toMatchObject({
        id: node.id,
        name: node.name,
        status: 'enrolled',
      });
    });

    it('refuses a node of another entity, a decommissioned one or one that does not exist', async () => {
      const api = await createApi();
      for (const nodeId of [
        (await nodeOf(programas, 'enrolled')).id,
        (await nodeOf(salud, 'decommissioned')).id,
        randomUUID(),
      ]) {
        const res = await register(api.id, nodeId);
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json<{ errors: Array<{ path: string }> }>().errors[0]?.path).toBe(
          'upstream.nodeId',
        );
      }
    });
  });

  describe('versions through X-Road (M4-05)', () => {
    // xroad is offered only where the deployment has the operator's Security Server (P-04).
    const saved = {
      url: process.env.DEN_XROAD_SECURITY_SERVER_URL,
      client: process.env.DEN_XROAD_CLIENT,
    };
    beforeAll(() => {
      process.env.DEN_XROAD_SECURITY_SERVER_URL = 'http://ss.xroad.test:8080';
      process.env.DEN_XROAD_CLIENT = 'CO/GOV/9000000001/DEN-GATEWAY';
    });
    afterAll(() => {
      for (const [name, value] of [
        ['DEN_XROAD_SECURITY_SERVER_URL', saved.url],
        ['DEN_XROAD_CLIENT', saved.client],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const serviceId = (memberCode: string) => ({
      instance: 'CO',
      memberClass: 'GOV',
      memberCode,
      serviceCode: 'consultaAfiliacion',
    });
    const register = async (apiId: string, memberCode: string) =>
      request('POST', `/api/v1/entities/${salud}/apis/${apiId}/versions`, 'pedro.publicador', {
        ...versionBody(),
        upstream: { type: 'xroad', serviceId: serviceId(memberCode) },
      });
    const code = `9${randomUUID().replace(/\D/g, '').slice(0, 9)}`;

    it('needs the entity X-Road member, set by the operator, and only that member', async () => {
      await prisma.entity.updateMany({
        where: { id: salud },
        data: { xroadMemberClass: null, xroadMemberCode: null },
      });
      const api = await createApi();
      expect((await register(api.id, code)).statusCode).toBe(400);

      const set = await request(
        'PUT',
        `/api/v1/admin/entities/${salud}/xroad-member`,
        'pablo.plataforma',
        { member: { memberClass: 'GOV', memberCode: code } },
      );
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toMatchObject({ xroadMember: { memberClass: 'GOV', memberCode: code } });
      // The entity cannot set it itself.
      expect(
        (
          await request('PUT', `/api/v1/admin/entities/${salud}/xroad-member`, 'elena.admin', {
            member: { memberClass: 'GOV', memberCode: '1' },
          })
        ).statusCode,
      ).toBe(403);

      expect((await register(api.id, '1234567890')).statusCode).toBe(400);
      const ok = await register(api.id, code);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(apiVersionDetailSchema.parse(ok.json()).upstream).toMatchObject({
        type: 'xroad',
        servicePath: '',
      });
      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { targetId: salud, action: 'entity.xroad_member_set' },
        orderBy: { seq: 'desc' },
      });
      expect(event.after).toMatchObject({ xroadMember: { memberCode: code } });

      // Another entity cannot take the same member.
      const taken = await request(
        'PUT',
        `/api/v1/admin/entities/${programas}/xroad-member`,
        'pablo.plataforma',
        { member: { memberClass: 'GOV', memberCode: code } },
      );
      expect(taken.statusCode).toBe(409);
    });
  });

  describe('happy path', () => {
    it('registers an API, uploads a version, lints it and submits it for review', async () => {
      const api = await createApi();
      expect(api.status).toBe('draft');

      const created = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions`,
        'pedro.publicador',
        versionBody(),
      );
      expect(created.statusCode, created.body).toBe(201);
      const version = apiVersionDetailSchema.parse(created.json());
      expect(version).toMatchObject({
        status: 'draft',
        basePath: `/salud/${api.slug}/v1`,
        allowedPurposes: ['eligibility_check'],
        lintReport: { valid: true },
        upstream: { type: 'node', servicePath: '/salud' },
      });
      expect(version.operations.map((o) => o.operationId)).toEqual([
        'getAfiliado',
        'verificarAfiliacion',
      ]);

      const submitted = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`,
        'pedro.publicador',
      );
      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json()).toMatchObject({ status: 'in_review' });

      // Submitting twice is an invalid transition.
      const again = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`,
        'pedro.publicador',
      );
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'invalid_transition' });

      const actions = (
        await prisma.auditEvent.findMany({
          where: { targetId: { in: [api.id, version.id] } },
          orderBy: { seq: 'asc' },
        })
      ).map((e) => e.action);
      expect(actions).toEqual(['api.created', 'api_version.created', 'api_version.submitted']);
    });
  });

  describe('lint gate', () => {
    it('keeps a version with lint errors in draft, shows line numbers and blocks submission', async () => {
      const api = await createApi();
      const broken = saludOpenapi.replace('      operationId: getAfiliado\n', '');
      const res = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions`,
        'pedro.publicador',
        versionBody(broken),
      );
      expect(res.statusCode).toBe(201);
      const version = apiVersionDetailSchema.parse(res.json());
      expect(version.lintReport.valid).toBe(false);
      const issue = version.lintReport.issues.find((i) => i.code === 'operation-operationId');
      expect(issue?.line).toBeGreaterThan(1);

      const submit = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`,
        'pedro.publicador',
      );
      expect(submit.statusCode).toBe(400);
      expect(submit.json<{ errors: Array<{ path: string }> }>().errors[0]?.path).toMatch(
        /^openapi:\d+$/,
      );

      // Fixing the document (replace) makes it submittable.
      const fixed = await request(
        'PUT',
        `/api/v1/entities/${salud}/apis/${api.id}/versions/${version.id}/openapi`,
        'pedro.publicador',
        { openapi: saludOpenapi },
      );
      expect(fixed.statusCode).toBe(200);
      expect(fixed.json()).toMatchObject({ lintReport: { valid: true } });
      const ok = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`,
        'pedro.publicador',
      );
      expect(ok.statusCode).toBe(200);
    });

    it('requires personal-data APIs to say whose data each operation handles (ADR-0015)', async () => {
      // The salud document without its x-den-data-subject declarations.
      const undeclared = saludOpenapi.replace(
        /^ {6}(#.*\n {6})?x-den-data-subject:\n( {8}.*\n)+/gm,
        '',
      );
      expect(undeclared).not.toContain('x-den-data-subject');

      const api = await createApi();
      const res = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions`,
        'pedro.publicador',
        versionBody(undeclared),
      );
      const version = apiVersionDetailSchema.parse(res.json());
      expect(version.lintReport.valid).toBe(false);
      expect(
        version.lintReport.issues.filter((i) => i.code === 'den-data-subject-required'),
      ).toHaveLength(2);
      expect(version.operations.map((o) => o.dataSubject)).toEqual([null, null]);
      const submit = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`,
        'pedro.publicador',
      );
      expect(submit.statusCode).toBe(400);

      // The declared document passes, and the version shows where each data subject is.
      const declared = await request(
        'PUT',
        `/api/v1/entities/${salud}/apis/${api.id}/versions/${version.id}/openapi`,
        'pedro.publicador',
        { openapi: saludOpenapi },
      );
      expect(apiVersionDetailSchema.parse(declared.json())).toMatchObject({
        lintReport: { valid: true },
        operations: [
          { operationId: 'getAfiliado', dataSubject: { in: 'path', name: 'numeroIdentificacion' } },
          {
            operationId: 'verificarAfiliacion',
            dataSubject: { in: 'body', pointer: '/numeroIdentificacion' },
          },
        ],
      });
    });

    it('does not require the declaration on APIs without personal data', async () => {
      const undeclared = saludOpenapi.replace(
        /^ {6}(#.*\n {6})?x-den-data-subject:\n( {8}.*\n)+/gm,
        '',
      );
      const created = await request('POST', `/api/v1/entities/${salud}/apis`, 'pedro.publicador', {
        ...apiBody(`internas-${run}-${randomUUID().slice(0, 4)}`),
        classification: 'internal',
      });
      const api = apiDetailSchema.parse(created.json());
      const res = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${api.id}/versions`,
        'pedro.publicador',
        {
          ...versionBody(undeclared),
          exposedFields: [{ name: 'regimen', personal: false, sensitive: false }],
        },
      );
      expect(apiVersionDetailSchema.parse(res.json()).lintReport.valid).toBe(true);
    });

    it('refuses personal or sensitive fields in an API classified below personal (M-20)', async () => {
      const undeclared = saludOpenapi.replace(
        /^ {6}(#.*\n {6})?x-den-data-subject:\n( {8}.*\n)+/gm,
        '',
      );
      const created = await request('POST', `/api/v1/entities/${salud}/apis`, 'pedro.publicador', {
        ...apiBody(`bajas-${run}-${randomUUID().slice(0, 4)}`),
        classification: 'internal',
      });
      const api = apiDetailSchema.parse(created.json());
      const versions = `/api/v1/entities/${salud}/apis/${api.id}/versions`;
      for (const field of [
        { name: 'regimen', personal: true, sensitive: false },
        { name: 'regimen', personal: false, sensitive: true },
      ]) {
        const res = await request('POST', versions, 'pedro.publicador', {
          ...versionBody(undeclared),
          exposedFields: [field],
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(JSON.stringify(res.json())).toContain('classification_below_fields');
      }
      expect(await prisma.apiVersion.count({ where: { apiId: api.id } })).toBe(0);
      // A row from before the rule is stopped when it is submitted.
      const ok = await request('POST', versions, 'pedro.publicador', {
        ...versionBody(undeclared),
        exposedFields: [{ name: 'regimen', personal: false, sensitive: false }],
      });
      const versionId = ok.json<{ id: string }>().id;
      await prisma.apiVersion.update({
        where: { id: versionId },
        data: { exposedFields: [{ name: 'regimen', personal: true, sensitive: false }] },
      });
      const submit = await request('POST', `${versions}/${versionId}/submit`, 'pedro.publicador');
      expect(submit.statusCode, submit.body).toBe(400);
    });
  });

  describe('editing a version that is not in review (M-19)', () => {
    let apiId = '';
    let versionId = '';
    const edit = (username: string, payload: object, id = versionId, entity = salud) =>
      request('PUT', `/api/v1/entities/${entity}/apis/${apiId}/versions/${id}`, username, payload);
    const declaration = () => {
      const { version: _version, ...rest } = versionBody();
      return rest;
    };

    beforeAll(async () => {
      apiId = (await createApi()).id;
      const res = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${apiId}/versions`,
        'pedro.publicador',
        versionBody(),
      );
      versionId = res.json<{ id: string }>().id;
    });

    it('replaces the declaration of a draft and audits it, keeping the OpenAPI when omitted', async () => {
      const res = await edit('pedro.publicador', {
        ...declaration(),
        exposedFields: [{ name: 'regimen', personal: true, sensitive: true }],
        legalBasisText: 'Base legal corregida.',
        legalReferences: ['Ley 1581 de 2012'],
      });
      expect(res.statusCode, res.body).toBe(200);
      const version = apiVersionDetailSchema.parse(res.json());
      expect(version).toMatchObject({
        status: 'draft',
        version: '1.0',
        exposedFields: [{ name: 'regimen', personal: true, sensitive: true }],
        legalBasisText: 'Base legal corregida.',
        lintReport: { valid: true },
      });
      const events = await prisma.auditEvent.findMany({
        where: { targetId: versionId, action: 'api_version.updated' },
      });
      expect(events).toHaveLength(1);
    });

    it('validates like createVersion', async () => {
      const bad = (extra: object) => edit('pedro.publicador', { ...declaration(), ...extra });
      expect((await bad({ allowedPurposes: ['inventado'] })).statusCode).toBe(400);
      expect((await bad({ upstream: { type: 'node', nodeId: randomUUID() } })).statusCode).toBe(
        400,
      );
      expect(
        (await bad({ upstream: { type: 'direct', baseUrl: 'http://interno.local' } })).statusCode,
      ).toBe(400);
    });

    it('works while changes are requested, and not in review', async () => {
      const base = `/api/v1/entities/${salud}/apis/${apiId}/versions/${versionId}`;
      expect((await request('POST', `${base}/submit`, 'pedro.publicador')).statusCode).toBe(200);
      expect((await edit('pedro.publicador', declaration())).statusCode).toBe(409);
      const asked = await request(
        'POST',
        `/api/v1/review/api-versions/${versionId}/request-changes`,
        'ana.operadora',
        { comment: 'Corrija los campos expuestos y la base legal.' },
      );
      expect(asked.statusCode, asked.body).toBe(200);
      const res = await edit('pedro.publicador', {
        ...declaration(),
        exposedFields: [{ name: 'estado', personal: true, sensitive: false }],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'changes_requested',
        exposedFields: [{ name: 'estado', personal: true, sensitive: false }],
      });
    });

    it('lets only the API publisher edit, and does not reach another entity', async () => {
      for (const user of ['lucia.datos', 'elena.admin']) {
        expect((await edit(user, declaration())).statusCode, user).toBe(403);
      }
      for (const user of ['carlos.dev', 'ana.operadora']) {
        expect((await edit(user, declaration())).statusCode, user).toBe(404);
      }
      expect((await edit('pedro.publicador', declaration(), versionId, programas)).statusCode).toBe(
        404,
      );
    });
  });

  describe('validation', () => {
    it('rejects duplicates, unknown sectors and purposes, and non-https direct upstreams', async () => {
      const api = await createApi();
      const dup = await request(
        'POST',
        `/api/v1/entities/${salud}/apis`,
        'pedro.publicador',
        apiBody(api.slug),
      );
      expect(dup.statusCode).toBe(409);

      const badSector = await request(
        'POST',
        `/api/v1/entities/${salud}/apis`,
        'pedro.publicador',
        {
          ...apiBody(`x-${run}-sector`),
          sector: 'astronomia',
        },
      );
      expect(badSector.statusCode).toBe(400);

      const versions = `/api/v1/entities/${salud}/apis/${api.id}/versions`;
      const badPurpose = await request('POST', versions, 'pedro.publicador', {
        ...versionBody(),
        allowedPurposes: ['spying'],
      });
      expect(badPurpose.statusCode).toBe(400);

      const httpUpstream = await request('POST', versions, 'pedro.publicador', {
        ...versionBody(),
        upstream: { type: 'direct', url: 'http://insecure.example.org' },
      });
      expect(httpUpstream.statusCode).toBe(400);

      // SSRF guard: a provider cannot point the gateway at the platform's own network.
      for (const url of ['https://keycloak:8443/admin', 'https://169.254.169.254/latest']) {
        const internal = await request('POST', versions, 'pedro.publicador', {
          ...versionBody(),
          upstream: { type: 'direct', url, mtls: false },
        });
        expect(internal.statusCode, url).toBe(400);
        expect(internal.json()).toMatchObject({ errors: [{ path: 'upstream.url' }] });
      }

      expect((await request('POST', versions, 'pedro.publicador', versionBody())).statusCode).toBe(
        201,
      );
      expect((await request('POST', versions, 'pedro.publicador', versionBody())).statusCode).toBe(
        409,
      );
    });
  });

  describe('authorization (403 for other members, 404 for other entities)', () => {
    let apiId = '';
    let versionId = '';

    beforeAll(async () => {
      apiId = (await createApi()).id;
      const res = await request(
        'POST',
        `/api/v1/entities/${salud}/apis/${apiId}/versions`,
        'pedro.publicador',
        versionBody(),
      );
      versionId = res.json<{ id: string }>().id;
    });

    it('lets every member and the operator/regulator read, but not the auditor or other entities', async () => {
      const url = `/api/v1/entities/${salud}/apis/${apiId}`;
      for (const user of [
        'pedro.publicador',
        'lucia.datos',
        'elena.admin',
        'ana.operadora',
        'marta.regulador',
      ]) {
        expect((await request('GET', url, user)).statusCode, user).toBe(200);
      }
      expect((await request('GET', url, 'carlos.dev')).statusCode).toBe(404);
      expect((await request('GET', url, 'sofia.auditora')).statusCode).toBe(404);
    });

    it('lets only the API publisher write', async () => {
      const create = `/api/v1/entities/${salud}/apis`;
      const submit = `/api/v1/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`;
      for (const user of ['lucia.datos', 'elena.admin']) {
        expect(
          (await request('POST', create, user, apiBody(`y-${run}-${user.slice(0, 4)}`))).statusCode,
          user,
        ).toBe(403);
        expect((await request('POST', submit, user)).statusCode, user).toBe(403);
      }
      for (const user of ['carlos.dev', 'ana.operadora', 'pablo.plataforma']) {
        expect(
          (await request('POST', create, user, apiBody(`z-${run}-${user.slice(0, 4)}`))).statusCode,
          user,
        ).toBe(404);
      }
    });

    it('does not reach an API through another entity the caller belongs to', async () => {
      // pedro publishes for salud and socioeconomico: the API of salud is not under socioeconomico.
      const socio = (await prisma.entity.findFirstOrThrow({ where: { slug: 'socioeconomico' } }))
        .id;
      expect(
        (await request('GET', `/api/v1/entities/${socio}/apis/${apiId}`, 'pedro.publicador'))
          .statusCode,
      ).toBe(404);
      expect(
        (await request('GET', `/api/v1/entities/${programas}/apis/${apiId}`, 'carlos.dev'))
          .statusCode,
      ).toBe(404);
    });
  });

  it('serves the purpose catalogue to any authenticated user', async () => {
    const res = await request('GET', '/api/v1/purposes', 'carlos.dev');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: Array<{ code: string }> }>().items.map((p) => p.code)).toContain(
      'eligibility_check',
    );
  });
});
