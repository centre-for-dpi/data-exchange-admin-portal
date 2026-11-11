import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { catalogDetailSchema, catalogPageSchema } from '@rid/contracts';
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

describe('catalogue (M1-05)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let published = { apiId: '', versionId: '', name: '' };
  let draftApiId = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findUniqueOrThrow({ where: { slug: 'salud' } })).id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);

    published = await createApi(`catalogo-${run}`, 'personal', true);
    draftApiId = (await createApi(`borrador-${run}`, 'personal', false)).apiId;
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (
    url: string,
    username?: string,
    method: 'GET' | 'POST' = 'GET',
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: username ? { authorization: `Bearer ${await issuer.token(subOf(username))}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function createApi(slug: string, classification: string, publish: boolean) {
    const name = `Catálogo ${slug}`;
    const api = await call(`/api/v1/entities/${salud}/apis`, 'pedro.publicador', 'POST', {
      slug,
      name,
      summary: 'Consulta de afiliación para el catálogo.',
      description: 'API de prueba con datos sintéticos.',
      sector: 'salud',
      tags: ['afiliacion'],
      classification,
      ownerContact: 'apis@salud.demo.rid.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const version = await call(
      `/api/v1/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      'POST',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: ['eligibility_check'],
        exposedFields: [
          { name: 'regimen', personal: true, sensitive: false },
          { name: 'aseguradora', personal: false, sensitive: false },
        ],
      },
    );
    const versionId = version.json<{ id: string }>().id;
    if (publish) {
      await call(
        `/api/v1/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
        'pedro.publicador',
        'POST',
      );
      const approved = await call(
        `/api/v1/review/api-versions/${versionId}/approve`,
        'ana.operadora',
        'POST',
        {},
      );
      expect(approved.json()).toMatchObject({ version: { status: 'published' } });
    }
    return { apiId, versionId, name };
  }

  const search = async (query: string, username = 'carlos.dev') => {
    const res = await call(`/api/v1/catalog/apis?${query}`, username);
    expect(res.statusCode, res.body).toBe(200);
    return catalogPageSchema.parse(res.json());
  };

  it('lists published APIs with the personal data they expose, never drafts', async () => {
    const page = await search(`q=${encodeURIComponent(run)}&limit=100`);
    const ids = page.items.map((i) => i.api.id);
    expect(ids).toContain(published.apiId);
    expect(ids).not.toContain(draftApiId);
    const item = page.items.find((i) => i.api.id === published.apiId);
    expect(item).toMatchObject({
      entity: { slug: 'salud' },
      latestVersion: { version: '1.0', status: 'published', basePath: `/salud/catalogo-${run}/v1` },
      personalFields: ['regimen'],
      sensitiveFields: [],
    });
  });

  it('filters by text, sector, entity and classification', async () => {
    const has = async (query: string) =>
      (await search(`${query}&limit=100`)).items.some((i) => i.api.id === published.apiId);
    expect(await has(`q=${encodeURIComponent(published.name.toUpperCase())}`)).toBe(true);
    expect(await has('q=afiliacion')).toBe(true); // tag
    expect(await has('sector=salud')).toBe(true);
    expect(await has('sector=movilidad')).toBe(false);
    expect(await has('entity=salud')).toBe(true);
    expect(await has('entity=programas-sociales')).toBe(false);
    expect(await has('classification=personal')).toBe(true);
    expect(await has('classification=public')).toBe(false);
    expect(
      (await call('/api/v1/catalog/apis?classification=secret', 'carlos.dev')).statusCode,
    ).toBe(400);
  });

  it('serves the service sheet of a published API', async () => {
    const res = await call(`/api/v1/catalog/apis/${published.apiId}`, 'carlos.dev');
    expect(res.statusCode).toBe(200);
    const detail = catalogDetailSchema.parse(res.json());
    expect(detail.entity.legalName).toBe('Entidad de Salud (ficticia)');
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]).toMatchObject({
      gatewayUrl: `http://localhost:9080/salud/catalogo-${run}/v1`,
      allowedPurposes: [{ code: 'eligibility_check' }],
      operations: [{ operationId: 'getAfiliado' }, { operationId: 'verificarAfiliacion' }],
    });
    expect((await call(`/api/v1/catalog/apis/${draftApiId}`, 'carlos.dev')).statusCode).toBe(404);
  });

  it('publishes the OpenAPI with the gateway as its only server', async () => {
    const res = await call(
      `/api/v1/catalog/apis/${published.apiId}/versions/${published.versionId}/openapi`,
      'carlos.dev',
    );
    expect(res.statusCode).toBe(200);
    const spec = res.json<{ servers: Array<{ url: string }>; paths: Record<string, unknown> }>();
    expect(spec.servers).toEqual([
      { url: `http://localhost:9080/salud/catalogo-${run}/v1`, description: 'RID gateway' },
    ]);
    expect(Object.keys(spec.paths)).toEqual([
      '/afiliados/{numeroIdentificacion}',
      '/afiliados/verificaciones',
    ]);
  });

  it('lists provider entities with published APIs', async () => {
    const res = await call('/api/v1/catalog/entities', 'carlos.dev');
    expect(res.json<{ items: Array<{ slug: string }> }>().items.map((e) => e.slug)).toContain(
      'salud',
    );
  });

  it('is visible to every authenticated user, and closed to anonymous visitors without publicCatalog', async () => {
    for (const user of ['carlos.dev', 'pedro.publicador', 'ana.operadora', 'sofia.auditora']) {
      expect((await call('/api/v1/catalog/apis', user)).statusCode, user).toBe(200);
    }
    // co.yaml: features.publicCatalog = false
    expect((await call('/api/v1/catalog/apis')).statusCode).toBe(401);
    expect((await call(`/api/v1/catalog/apis/${published.apiId}`)).statusCode).toBe(401);
    // A present but invalid token is never treated as anonymous.
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/apis',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(bad.statusCode).toBe(401);
  });
});
