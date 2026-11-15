import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { apiDetailSchema, apiVersionDetailSchema } from '@rid/contracts';
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
    ownerContact: 'apis@salud.demo.rid.example',
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
      // The salud document without its x-rid-data-subject declarations.
      const undeclared = saludOpenapi.replace(
        /^ {6}(#.*\n {6})?x-rid-data-subject:\n( {8}.*\n)+/gm,
        '',
      );
      expect(undeclared).not.toContain('x-rid-data-subject');

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
        version.lintReport.issues.filter((i) => i.code === 'rid-data-subject-required'),
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
        /^ {6}(#.*\n {6})?x-rid-data-subject:\n( {8}.*\n)+/gm,
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
        versionBody(undeclared),
      );
      expect(apiVersionDetailSchema.parse(res.json()).lintReport.valid).toBe(true);
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
