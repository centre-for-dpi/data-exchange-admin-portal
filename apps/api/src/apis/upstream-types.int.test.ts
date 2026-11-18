import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { getCountryConfig, loadCountryConfig, type UpstreamType } from '@den/config';
import {
  apiDetailSchema,
  apiVersionDetailSchema,
  reviewDetailSchema,
  syncPageSchema,
  upstreamTypesSchema,
} from '@den/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

const saludOpenapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const XROAD_ENV = ['DEN_XROAD_SECURITY_SERVER_URL', 'DEN_XROAD_CLIENT'] as const;

/**
 * Upstream types per country (P-04, ADR-0029): the API refuses, on create, revise, draft edit and
 * submission, a type the country does not list in features.upstreams, and `xroad` without the
 * deployment's X-Road settings. Versions that already have one keep working and are flagged to
 * the operator. The configuration is this file's own (each integration file has its own module
 * registry), changed per test.
 */
describe('upstream types per country (P-04)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  const savedEnv = Object.fromEntries(XROAD_ENV.map((name) => [name, process.env[name]]));
  let countryUpstreams: UpstreamType[] = [];
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
    countryUpstreams = [...getCountryConfig().features.upstreams];
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterEach(() => {
    getCountryConfig().features.upstreams = [...countryUpstreams];
    for (const name of XROAD_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  /** The country lists `upstreams`; the deployment has X-Road settings or not. */
  const deployment = (upstreams: UpstreamType[], xroad: boolean) => {
    getCountryConfig().features.upstreams = upstreams;
    for (const name of XROAD_ENV) delete process.env[name];
    if (xroad) {
      process.env.DEN_XROAD_SECURITY_SERVER_URL = 'http://ss.xroad.test:8080';
      process.env.DEN_XROAD_CLIENT = 'CO/GOV/9000000001/DEN-GATEWAY';
    }
  };

  const request = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    username?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: username ? { authorization: `Bearer ${await issuer.token(sub(username))}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const createApi = async () => {
    const res = await request('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `canal-${run}-${randomUUID().slice(0, 4)}`,
      name: 'Consulta de afiliación',
      summary: 'Consulta el estado de afiliación de una persona.',
      description: 'API de prueba con datos sintéticos.',
      sector: 'salud',
      tags: [],
      classification: 'personal',
      ownerContact: 'apis@salud.demo.den.example',
    });
    expect(res.statusCode, res.body).toBe(201);
    return apiDetailSchema.parse(res.json()).id;
  };

  const node = { type: 'node', servicePath: '/salud' };
  const direct = { type: 'direct', url: 'https://api.salud.example.org/v1', mtls: false };
  const xroad = (memberCode: string) => ({
    type: 'xroad',
    serviceId: { instance: 'CO', memberClass: 'GOV', memberCode, serviceCode: 'consulta' },
  });
  const versionBody = (upstream: object, sandboxUpstream?: object, version = '1.0') => ({
    version,
    openapi: saludOpenapi,
    upstream,
    ...(sandboxUpstream ? { sandboxUpstream } : {}),
    exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
    allowedPurposes: ['eligibility_check'],
  });
  const create = async (
    apiId: string,
    upstream: object,
    sandbox?: object,
    user = 'pedro.publicador',
  ) =>
    request(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      user,
      versionBody(upstream, sandbox),
    );
  const refusal = (res: { statusCode: number; json: () => unknown }) => {
    expect(res.statusCode).toBe(400);
    return res.json() as { code: string; errors: Array<{ path: string; key?: string }> };
  };

  describe('the types the deployment offers', () => {
    it('are the country list, with xroad only where X-Road is configured', async () => {
      const allowed = async () =>
        upstreamTypesSchema.parse((await request('GET', '/upstream-types', 'carlos.dev')).json())
          .allowed;
      // co.yaml: the node and X-Road, no direct.
      expect(countryUpstreams).toEqual(['node', 'xroad']);
      deployment(['node', 'xroad'], false);
      expect(await allowed()).toEqual(['node']);
      deployment(['node', 'xroad'], true);
      expect(await allowed()).toEqual(['node', 'xroad']);
      deployment(['direct', 'node'], false);
      expect(await allowed()).toEqual(['node', 'direct']);
      deployment(['xroad', 'direct', 'node'], true);
      expect(await allowed()).toEqual(['node', 'xroad', 'direct']);
    });

    it('are readable by any session, not anonymously', async () => {
      for (const user of [
        'pedro.publicador',
        'sofia.auditora',
        'pablo.plataforma',
        'marta.regulador',
      ]) {
        expect((await request('GET', '/upstream-types', user)).statusCode, user).toBe(200);
      }
      expect((await request('GET', '/upstream-types')).statusCode).toBe(401);
    });
  });

  describe('creating a version', () => {
    it('refuses direct where the country does not list it, as upstream or sandbox (400)', async () => {
      deployment(['node', 'xroad'], true);
      const apiId = await createApi();
      const before = await prisma.auditEvent.count({ where: { action: 'api_version.created' } });

      const upstream = refusal(await create(apiId, direct));
      expect(upstream).toMatchObject({
        code: 'validation_failed',
        errors: [{ path: 'upstream.type', key: 'upstream_type_not_allowed' }],
      });
      const sandbox = refusal(await create(apiId, node, direct));
      expect(sandbox.errors).toEqual([
        expect.objectContaining({ path: 'sandboxUpstream.type', key: 'upstream_type_not_allowed' }),
      ]);
      expect(await prisma.apiVersion.count({ where: { apiId } })).toBe(0);
      expect(await prisma.auditEvent.count({ where: { action: 'api_version.created' } })).toBe(
        before,
      );

      // The node is always fine here, with or without a node sandbox.
      expect((await create(apiId, node, node)).statusCode).toBe(201);
    });

    it('refuses xroad without the deployment X-Road settings, and where not listed (400)', async () => {
      const code = `8${randomUUID().replace(/\D/g, '').slice(0, 9)}`;
      await prisma.entity.update({
        where: { id: salud },
        data: { xroadMemberClass: 'GOV', xroadMemberCode: code },
      });
      try {
        deployment(['node', 'xroad'], false);
        const apiId = await createApi();
        expect(refusal(await create(apiId, xroad(code))).errors).toEqual([
          expect.objectContaining({ path: 'upstream.type', key: 'xroad_not_configured' }),
        ]);
        expect(refusal(await create(apiId, node, xroad(code))).errors).toEqual([
          expect.objectContaining({ path: 'sandboxUpstream.type', key: 'xroad_not_configured' }),
        ]);

        deployment(['node', 'direct'], true);
        expect(refusal(await create(apiId, xroad(code))).errors).toEqual([
          expect.objectContaining({ path: 'upstream.type', key: 'upstream_type_not_allowed' }),
        ]);

        deployment(['node', 'xroad'], true);
        const ok = await create(apiId, xroad(code));
        expect(ok.statusCode, ok.body).toBe(201);
      } finally {
        await prisma.entity.update({
          where: { id: salud },
          data: { xroadMemberClass: null, xroadMemberCode: null },
        });
      }
    });

    it('accepts direct where the country opts in', async () => {
      deployment(['node', 'direct'], false);
      const apiId = await createApi();
      const res = await create(apiId, direct, direct);
      expect(res.statusCode, res.body).toBe(201);
      const detail = apiVersionDetailSchema.parse(res.json());
      expect(detail.upstream.type).toBe('direct');
      expect(detail.disallowedUpstreamTypes).toEqual([]);
    });

    it('checks the role before the type: 403 for other members, 404 for other entities', async () => {
      deployment(['node', 'xroad'], false);
      const apiId = await createApi();
      expect((await create(apiId, direct, undefined, 'elena.admin')).statusCode).toBe(403);
      const other = await request(
        'POST',
        `/entities/${programas}/apis/${apiId}/versions`,
        'pedro.publicador',
        versionBody(direct),
      );
      expect(other.statusCode).toBe(404);
    });
  });

  describe('a version whose type the country no longer accepts', () => {
    /** A version registered while direct was allowed; then the country drops it. */
    const directVersion = async (status: 'draft' | 'published', sandboxOnly = false) => {
      deployment(['node', 'direct'], false);
      const apiId = await createApi();
      const res = await create(
        apiId,
        sandboxOnly ? node : direct,
        sandboxOnly ? direct : undefined,
      );
      expect(res.statusCode, res.body).toBe(201);
      const versionId = apiVersionDetailSchema.parse(res.json()).id;
      if (status === 'published') {
        await prisma.apiVersion.update({
          where: { id: versionId },
          data: { status: 'published', publishedAt: new Date() },
        });
      }
      deployment(['node', 'xroad'], false);
      return { apiId, versionId, url: `/entities/${salud}/apis/${apiId}/versions/${versionId}` };
    };
    const revised = saludOpenapi.replace(
      'title: Consulta de afiliación en salud',
      'title: Consulta de afiliación en salud (revisada)',
    );

    it('is flagged on its sheet, to the provider and the operator', async () => {
      const published = await directVersion('published');
      const sandboxOnly = await directVersion('published', true);
      const provider = await request('GET', published.url, 'pedro.publicador');
      expect(provider.statusCode, provider.body).toBe(200);
      expect(apiVersionDetailSchema.parse(provider.json()).disallowedUpstreamTypes).toEqual([
        'direct',
      ]);
      const operator = await request(
        'GET',
        `/review/api-versions/${published.versionId}`,
        'pablo.plataforma',
      );
      expect(operator.statusCode, operator.body).toBe(200);
      expect(reviewDetailSchema.parse(operator.json()).version.disallowedUpstreamTypes).toEqual([
        'direct',
      ]);
      const sandbox = apiVersionDetailSchema.parse(
        (await request('GET', sandboxOnly.url, 'pedro.publicador')).json(),
      );
      expect(sandbox.disallowedUpstreamTypes).toEqual(['direct']);

      // Where the country opts in again, nothing is flagged.
      deployment(['node', 'direct'], false);
      const again = apiVersionDetailSchema.parse(
        (await request('GET', published.url, 'pedro.publicador')).json(),
      );
      expect(again.disallowedUpstreamTypes).toEqual([]);
    });

    it('is listed in the sync console for the operator, who decides', async () => {
      const published = await directVersion('published');
      const sandboxOnly = await directVersion('published', true);
      const retired = await directVersion('published');
      await prisma.apiVersion.update({
        where: { id: retired.versionId },
        data: { status: 'retired', retiredAt: new Date() },
      });
      const fine = await directVersion('draft');
      deployment(['node', 'direct'], false);
      await prisma.apiVersion.update({
        where: { id: fine.versionId },
        data: { upstreamType: 'node', upstream: node },
      });
      deployment(['node', 'xroad'], false);

      const res = await request('GET', '/admin/sync', 'pablo.plataforma');
      expect(res.statusCode, res.body).toBe(200);
      const flagged = syncPageSchema.parse(res.json()).disallowedUpstreams;
      expect(flagged).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            versionId: published.versionId,
            status: 'published',
            apiName: 'Consulta de afiliación',
            types: ['direct'],
          }),
          expect.objectContaining({ versionId: sandboxOnly.versionId, types: ['direct'] }),
        ]),
      );
      const ids = flagged.map((f) => f.versionId);
      expect(ids).not.toContain(retired.versionId);
      expect(ids).not.toContain(fine.versionId);

      // The console stays the operator's: a provider gets 403.
      expect((await request('GET', '/admin/sync', 'pedro.publicador')).statusCode).toBe(403);
    });

    it('keeps its route: nothing is queued to remove it', async () => {
      const published = await directVersion('published');
      const res = await request('GET', published.url, 'pedro.publicador');
      expect(apiVersionDetailSchema.parse(res.json()).status).toBe('published');
      const jobs = await prisma.outboxMessage.count({
        where: { aggregate: `apiVersion:${published.versionId}` },
      });
      expect(jobs).toBe(0);
    });

    it('cannot be revised, edited or submitted with that type (400)', async () => {
      const published = await directVersion('published');
      const revise = refusal(
        await request('PUT', `${published.url}/openapi`, 'pedro.publicador', { openapi: revised }),
      );
      expect(revise.errors).toEqual([
        expect.objectContaining({ path: 'upstream.type', key: 'upstream_type_not_allowed' }),
      ]);
      expect(
        (await prisma.apiVersion.findUniqueOrThrow({ where: { id: published.versionId } })).version,
      ).toBe('1.0');

      const draft = await directVersion('draft', true);
      expect(
        refusal(
          await request('PUT', `${draft.url}/openapi`, 'pedro.publicador', { openapi: revised }),
        ).errors,
      ).toEqual([expect.objectContaining({ path: 'sandboxUpstream.type' })]);
      expect(
        refusal(await request('POST', `${draft.url}/submit`, 'pedro.publicador')).errors,
      ).toEqual([expect.objectContaining({ path: 'sandboxUpstream.type' })]);
      expect(
        (await prisma.apiVersion.findUniqueOrThrow({ where: { id: draft.versionId } })).status,
      ).toBe('draft');

      // With the type allowed again, the same revision goes through.
      deployment(['node', 'direct'], false);
      const ok = await request('PUT', `${published.url}/openapi`, 'pedro.publicador', {
        openapi: revised,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(apiVersionDetailSchema.parse(ok.json()).version).toBe('1.1');
    });

    it('a node version is revised as before', async () => {
      deployment(['node', 'xroad'], false);
      const apiId = await createApi();
      const res = await create(apiId, node);
      const versionId = apiVersionDetailSchema.parse(res.json()).id;
      await prisma.apiVersion.update({
        where: { id: versionId },
        data: { status: 'published', publishedAt: new Date() },
      });
      const ok = await request(
        'PUT',
        `/entities/${salud}/apis/${apiId}/versions/${versionId}/openapi`,
        'pedro.publicador',
        { openapi: revised },
      );
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });
});
