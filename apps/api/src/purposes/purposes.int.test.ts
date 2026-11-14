import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  apiVersionDetailSchema,
  createdApplicationSchema,
  purposeAdminListSchema,
  purposeListSchema,
} from '@rid/contracts';
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

describe('purpose catalogue (M2-10)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
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

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(subOf(who))}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const newPurpose = async () => {
    const code = `prueba_${randomUUID()
      .slice(0, 8)
      .replace(/[^a-z]/g, 'x')}`;
    const res = await call('POST', '/admin/purposes', 'ana.operadora', {
      code,
      name: { es: 'Prueba de finalidad', en: 'Purpose test' },
      description: { es: 'Finalidad creada por una prueba.', en: 'Purpose created by a test.' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return code;
  };

  async function publishedVersion(purposes: string[]) {
    const slug = `fin-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: `Finalidades ${slug}`,
      summary: 'API para probar finalidades.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@salud.demo.rid.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const v = await call('POST', `/entities/${salud}/apis/${apiId}/versions`, 'pedro.publicador', {
      version: '1.0',
      openapi,
      upstream: { type: 'node', servicePath: '/salud' },
      allowedPurposes: purposes,
      exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
    });
    expect(v.statusCode, v.body).toBe(201);
    const versionId = v.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {});
    return { apiId, versionId, url: `/entities/${salud}/apis/${apiId}/versions/${versionId}` };
  }

  it('the operator adds a purpose; it shows in the catalogue, audited', async () => {
    const code = await newPurpose();
    const all = purposeAdminListSchema.parse(
      (await call('GET', '/admin/purposes', 'marta.regulador')).json(),
    );
    expect(all.items.find((p) => p.code === code)).toMatchObject({
      source: 'operator',
      active: true,
    });
    const visible = purposeListSchema.parse((await call('GET', '/purposes', 'carlos.dev')).json());
    expect(visible.items.map((p) => p.code)).toContain(code);
    expect(
      await prisma.auditEvent.count({ where: { targetId: code, action: 'purpose.created' } }),
    ).toBe(1);
    const again = await call('POST', '/admin/purposes', 'ana.operadora', {
      code,
      name: { es: 'Otra', en: 'Other' },
      description: { es: 'Otra descripción.', en: 'Another description.' },
    });
    expect(again.statusCode).toBe(409);
    const bad = await call('POST', '/admin/purposes', 'ana.operadora', {
      code: 'Con Espacios',
      name: { es: 'Mala', en: 'Bad' },
      description: { es: 'Código inválido.', en: 'Invalid code.' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('edits the operator’s purposes; config ones are edited in the configuration', async () => {
    const code = await newPurpose();
    const res = await call('PUT', `/admin/purposes/${code}`, 'ana.operadora', {
      name: { es: 'Nombre corregido', en: 'Corrected name' },
      description: { es: 'Descripción corregida.', en: 'Corrected description.' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const config = await call('PUT', '/admin/purposes/eligibility_check', 'ana.operadora', {
      name: { es: 'Cambio', en: 'Change' },
      description: { es: 'No debe aplicarse.', en: 'Must not apply.' },
    });
    expect(config.statusCode).toBe(409);
  });

  it('a deactivated purpose is not offered for new versions or requests; existing ones keep it', async () => {
    const code = await newPurpose();
    const { versionId } = await publishedVersion(['eligibility_check', code]);
    const app1 = createdApplicationSchema.parse(
      (
        await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
          name: `Fin ${randomUUID().slice(0, 6)}`,
          description: 'Aplicación de prueba de finalidades.',
          environment: 'production',
          technicalContact: 'dev@programas.demo.rid.example',
        })
      ).json(),
    ).application.id;
    const request = (purposeCode: string) =>
      call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
        applicationId: app1,
        apiVersionId: versionId,
        purposeCode,
        purposeDetail: 'Verificar afiliación con la finalidad de prueba.',
        legalBasisText: 'Ley de protección de datos, artículo 10.',
        validityMonths: 12,
      });
    const existing = await request(code);
    expect(existing.statusCode, existing.body).toBe(201);
    const existingId = existing.json<{ id: string }>().id;

    expect(
      (await call('POST', `/admin/purposes/${code}/deactivate`, 'ana.operadora')).statusCode,
    ).toBe(200);
    expect(
      purposeListSchema
        .parse((await call('GET', '/purposes', 'carlos.dev')).json())
        .items.map((p) => p.code),
    ).not.toContain(code);
    // The existing request keeps its purpose; a new one cannot use it.
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: existingId } })).purposeCode,
    ).toBe(code);
    await call(
      'POST',
      `/entities/${programas}/subscriptions/${existingId}/withdraw`,
      'carlos.dev',
      {},
    );
    expect((await request(code)).statusCode).toBe(400);
    const draft = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `fin2-${randomUUID().slice(0, 8)}`,
      name: 'Finalidades dos',
      summary: 'API para probar finalidades.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@salud.demo.rid.example',
    });
    const v = await call(
      'POST',
      `/entities/${salud}/apis/${draft.json<{ id: string }>().id}/versions`,
      'pedro.publicador',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: [code],
        exposedFields: [],
      },
    );
    expect(v.statusCode).toBe(400);

    expect(
      (await call('POST', `/admin/purposes/${code}/deactivate`, 'ana.operadora')).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `/admin/purposes/${code}/activate`, 'ana.operadora')).statusCode,
    ).toBe(200);
    expect(
      await prisma.auditEvent.count({
        where: { targetId: code, action: { in: ['purpose.deactivated', 'purpose.activated'] } },
      }),
    ).toBe(2);
  });

  it('the data steward chooses the purposes of a version, among active ones', async () => {
    const code = await newPurpose();
    const { url } = await publishedVersion(['eligibility_check']);
    const res = await call('PUT', `${url}/purposes`, 'lucia.datos', {
      allowedPurposes: ['eligibility_check', code],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(apiVersionDetailSchema.parse(res.json()).allowedPurposes).toEqual(
      ['eligibility_check', code].sort(),
    );
    expect(
      (
        await call('PUT', `${url}/purposes`, 'pedro.publicador', {
          allowedPurposes: ['eligibility_check'],
        })
      ).statusCode,
    ).toBe(403);
    await call('POST', `/admin/purposes/${code}/deactivate`, 'ana.operadora');
    expect(
      (await call('PUT', `${url}/purposes`, 'lucia.datos', { allowedPurposes: [code] })).statusCode,
    ).toBe(400);
    const versionId = url.split('/').at(-1) ?? '';
    expect(
      await prisma.auditEvent.count({
        where: { targetId: versionId, action: 'api_version.purposes_changed' },
      }),
    ).toBe(1);
  });

  it('only operator staff manage the catalogue; the regulator reads it', async () => {
    for (const who of ['marta.regulador', 'lucia.datos', 'sofia.auditora']) {
      const res = await call('POST', '/admin/purposes', who, {
        code: 'no_permitida',
        name: { es: 'No', en: 'No' },
        description: { es: 'No debe crearse.', en: 'Must not be created.' },
      });
      expect(res.statusCode).toBe(403);
    }
    expect((await call('GET', '/admin/purposes', 'lucia.datos')).statusCode).toBe(403);
  });
});
