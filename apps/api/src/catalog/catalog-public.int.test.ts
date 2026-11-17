import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { catalogDetailSchema, catalogPageSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

const repo = resolve(import.meta.dirname, '../../../..');
const openapi = readFileSync(join(repo, 'infra/mock-providers/salud/openapi.yaml'), 'utf8');

/**
 * The public catalogue (SPEC.md §2.3, M6-08): with features.publicCatalog, anonymous visitors
 * browse the public APIs only, without who answers for them nor the state of the entity's nodes.
 * This file runs the API with a copy of co.yaml that turns the flag on (each integration file has
 * its own module registry, so its configuration).
 */
describe('public catalogue (M6-08)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  const configDir = mkdtempSync(join(tmpdir(), 'rid-config-'));
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let open = { apiId: '', versionId: '' };
  let personal = { apiId: '', versionId: '' };

  beforeAll(async () => {
    cpSync(join(repo, 'config/country'), configDir, { recursive: true });
    const co = join(configDir, 'co.yaml');
    const yaml = readFileSync(co, 'utf8');
    expect(yaml).toMatch(/^ {2}publicCatalog: false$/m);
    writeFileSync(co, yaml.replace(/^ {2}publicCatalog: false$/m, '  publicCatalog: true'));
    process.env.RID_CONFIG_DIR = configDir;

    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
    open = await publish(`abierta-${run}`, 'public');
    personal = await publish(`personal-${run}`, 'personal');
  });
  afterAll(async () => {
    delete process.env.RID_CONFIG_DIR;
    await app.close();
    await prisma.$disconnect();
    rmSync(configDir, { recursive: true, force: true });
  });

  const call = async (url: string, username?: string, method = 'GET', payload?: unknown) =>
    app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: username ? { authorization: `Bearer ${await issuer.token(subOf(username))}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  async function publish(slug: string, classification: 'public' | 'personal') {
    const api = await call(`/api/v1/entities/${salud}/apis`, 'pedro.publicador', 'POST', {
      slug,
      name: `Catálogo público ${slug}`,
      summary: 'Consulta para el catálogo público.',
      description: 'API de prueba con datos sintéticos.',
      sector: 'salud',
      tags: ['catalogo'],
      classification,
      ownerContact: 'responsable.apis@salud.demo.rid.example',
    });
    expect(api.statusCode, api.body).toBe(201);
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
          { name: 'aseguradora', personal: classification === 'personal', sensitive: false },
        ],
      },
    );
    expect(version.statusCode, version.body).toBe(201);
    const versionId = version.json<{ id: string }>().id;
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
    return { apiId, versionId };
  }

  it('lists only public APIs to anonymous visitors', async () => {
    const res = await call(`/api/v1/catalog/apis?q=${run}`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = catalogPageSchema.parse(res.json()).items.map((i) => i.api.id);
    expect(ids).toContain(open.apiId);
    expect(ids).not.toContain(personal.apiId);
    expect((await call(`/api/v1/catalog/apis/${personal.apiId}`)).statusCode).toBe(404);
    const versionDoc = `/api/v1/catalog/apis/${personal.apiId}/versions/${personal.versionId}/openapi`;
    expect((await call(versionDoc)).statusCode).toBe(404);
  });

  it('shows a public API without its contact nor the node state', async () => {
    const anonymous = catalogDetailSchema.parse(
      (await call(`/api/v1/catalog/apis/${open.apiId}`)).json(),
    );
    expect(anonymous.api.ownerContact).toBeNull();
    expect(anonymous.versions.every((v) => v.node === null)).toBe(true);
    expect(
      (await call(`/api/v1/catalog/apis/${open.apiId}/versions/${open.versionId}/openapi`))
        .statusCode,
    ).toBe(200);

    // Signed in, the same API with everything.
    const signedIn = catalogDetailSchema.parse(
      (await call(`/api/v1/catalog/apis/${open.apiId}`, 'carlos.dev')).json(),
    );
    expect(signedIn.api.ownerContact).toBe('responsable.apis@salud.demo.rid.example');
  });

  it('never treats an invalid token as an anonymous visit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/apis',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
