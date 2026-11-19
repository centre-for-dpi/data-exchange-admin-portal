import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  createdApplicationSchema,
  documentPageSchema,
  subscriptionDetailSchema,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { MAX_DOCUMENT_REPLACEMENTS } from './documents.service.js';
import { StorageService } from './storage.service.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

describe('exchange agreements and deletion by legal order (M2-07)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const documentsDir = mkdtempSync(join(tmpdir(), 'den-agreements-'));
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';
  let programas = '';
  let versionId = '';

  const token = (who: string) => issuer.token(subOf(who));
  const call = async (method: 'GET' | 'POST', url: string, who: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await token(who)}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const upload = async (id: string, who: string, bytes: Buffer, type = 'application/pdf') =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/entities/${programas}/subscriptions/${id}/agreement?fileName=acuerdo.pdf`,
      headers: { authorization: `Bearer ${await token(who)}`, 'content-type': type },
      payload: bytes,
    });

  beforeAll(async () => {
    process.env.DEN_DOCUMENTS_DIR = documentsDir;
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    programas = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } }))
      .id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
    const slug = `acuerdo-${randomUUID().slice(0, 8)}`;
    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug,
      name: `Acuerdo ${slug}`,
      summary: 'API para probar acuerdos de intercambio.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      classification: 'personal',
      ownerContact: 'apis@salud.demo.den.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const version = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: ['eligibility_check'],
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
      },
    );
    versionId = version.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {});
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    rmSync(documentsDir, { recursive: true, force: true });
  });

  async function requested() {
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Acuerdo ${randomUUID().slice(0, 6)}`,
      description: 'Aplicación de prueba de acuerdos.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.den.example',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const res = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar un subsidio.',
      legalBasisText: 'Ley de protección de datos, artículo 10.',
      validityMonths: 12,
    });
    return subscriptionDetailSchema.parse(res.json()).id;
  }

  it('the requester attaches the agreement; both sides and the regulator can download it', async () => {
    const id = await requested();
    const res = await upload(id, 'carlos.dev', PDF);
    expect(res.statusCode, res.body).toBe(200);
    const doc = subscriptionDetailSchema.parse(res.json()).agreementDocument;
    expect(doc).toMatchObject({
      fileName: 'acuerdo.pdf',
      size: PDF.length,
      mimeType: 'application/pdf',
    });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc?.id ?? '' } })).toMatchObject(
      {
        kind: 'agreement',
        ownerEntityId: programas,
      },
    );

    for (const [who, url] of [
      ['carlos.dev', `/entities/${programas}/subscriptions/${id}/agreement`],
      ['lucia.datos', `/entities/${salud}/access-requests/${id}/agreement`],
      ['marta.regulador', `/entities/${salud}/access-requests/${id}/agreement`],
    ] as const) {
      const download = await call('GET', url, who);
      expect(download.statusCode, `${who} ${download.body}`).toBe(200);
      expect(download.headers['content-disposition']).toContain('attachment');
      expect(download.rawPayload.equals(PDF)).toBe(true);
    }
    // Another entity's admin learns nothing.
    expect(
      (await call('GET', `/entities/${salud}/subscriptions/${id}/agreement`, 'elena.admin'))
        .statusCode,
    ).toBe(404);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: id, action: 'subscription.agreement_attached' },
    });
    expect(audit.after).toMatchObject({ sha256: doc?.sha256 });
  });

  it('accepts only PDFs, only from the requesting side, and only before the decision', async () => {
    const id = await requested();
    expect((await upload(id, 'carlos.dev', Buffer.from('not a pdf'))).statusCode).toBe(415);
    expect((await upload(id, 'lucia.datos', PDF)).statusCode).toBe(404);
    await call('POST', `/entities/${salud}/access-requests/${id}/approve`, 'lucia.datos', {});
    expect((await upload(id, 'carlos.dev', PDF)).statusCode).toBe(409);
  });

  it('caps how many times the agreement can be replaced (B-09)', async () => {
    const id = await requested();
    // The first upload plus MAX_DOCUMENT_REPLACEMENTS replacements are accepted; the next is not.
    for (let n = 0; n <= MAX_DOCUMENT_REPLACEMENTS; n++) {
      const res = await upload(id, 'carlos.dev', PDF);
      expect(res.statusCode, `upload ${n + 1}: ${res.body}`).toBe(200);
    }
    expect((await upload(id, 'carlos.dev', PDF)).statusCode).toBe(409);
  });

  it('the operator deletes the bytes by legal order: audited, hash kept, downloads answer 410', async () => {
    const id = await requested();
    const doc = subscriptionDetailSchema.parse(
      (await upload(id, 'carlos.dev', PDF)).json(),
    ).agreementDocument;
    const documentId = doc?.id ?? '';
    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const file = join(app.get(StorageService).dir, row.storageKey);
    expect(existsSync(file)).toBe(true);

    for (const who of ['ana.operadora', 'marta.regulador', 'carlos.dev']) {
      expect(
        (await call('POST', `/documents/${documentId}/purge`, who, { order: 'Auto 123 de 2026' }))
          .statusCode,
      ).toBe(403);
    }
    const res = await call('POST', `/documents/${documentId}/purge`, 'pablo.plataforma', {
      order: 'Juzgado 5 Civil, auto 123 de 2026',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(existsSync(file)).toBe(false);
    const after = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after).toMatchObject({
      sha256: row.sha256,
      purgeOrder: 'Juzgado 5 Civil, auto 123 de 2026',
    });
    expect(after.purgedAt).not.toBeNull();
    const download = await call(
      'GET',
      `/entities/${programas}/subscriptions/${id}/agreement`,
      'carlos.dev',
    );
    expect(download.statusCode).toBe(410);
    expect(
      (
        await call('POST', `/documents/${documentId}/purge`, 'pablo.plataforma', {
          order: 'Otra orden',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      await prisma.auditEvent.count({ where: { targetId: documentId, action: 'document.purged' } }),
    ).toBe(1);
  });

  it('the operator finds documents in a metadata-only register, filtered by owner and deletion', async () => {
    const id = await requested();
    const documentId =
      subscriptionDetailSchema.parse((await upload(id, 'carlos.dev', PDF)).json()).agreementDocument
        ?.id ?? '';
    const list = async (query: string, who = 'pablo.plataforma') =>
      call('GET', `/documents?${query}`, who);

    const res = await list(`ownerEntityId=${programas}&kind=agreement&purged=false&limit=100`);
    expect(res.statusCode, res.body).toBe(200);
    const page = documentPageSchema.parse(res.json());
    const item = page.items.find((d) => d.id === documentId);
    expect(item).toMatchObject({
      kind: 'agreement',
      owner: { id: programas },
      purgedAt: null,
      fileName: 'acuerdo.pdf',
    });
    expect(page.items.every((d) => d.owner.id === programas && d.purgedAt === null)).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain('storageKey');

    // Cursor pagination walks the same rows without repeating.
    const first = documentPageSchema.parse((await list('limit=1')).json());
    if (first.nextCursor) {
      const second = documentPageSchema.parse(
        (await list(`limit=1&cursor=${first.nextCursor}`)).json(),
      );
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    }

    await call('POST', `/documents/${documentId}/purge`, 'pablo.plataforma', {
      order: 'Juzgado 2 Administrativo, auto 77 de 2026',
    });
    const purged = documentPageSchema.parse((await list('purged=true&limit=100')).json());
    expect(purged.items.find((d) => d.id === documentId)).toMatchObject({
      purgeOrder: 'Juzgado 2 Administrativo, auto 77 de 2026',
    });

    for (const who of ['ana.operadora', 'marta.regulador', 'sofia.auditora', 'carlos.dev']) {
      expect((await list('', who)).statusCode).toBe(403);
    }
    expect((await list('kind=secret')).statusCode).toBe(400);
  });
});
