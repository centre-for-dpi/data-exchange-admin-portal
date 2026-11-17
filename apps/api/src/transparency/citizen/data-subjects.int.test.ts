import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  createdApplicationSchema,
  subjectAccessPageSchema,
  subscriptionDetailSchema,
  transparencyReceiptSchema,
} from '@den/contracts';
import { verifyReceipt } from '@den/transparency-verifier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestCitizenIssuer,
  createTestIssuer,
  type TestCitizenIssuer,
  type TestIssuer,
} from '../../../test/test-auth.js';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { routeId } from '../../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../../seed/realm.js';
import { runSeed } from '../../seed/seed.js';
import { TransparencyEvidenceService } from '../evidence/transparency-evidence.service.js';
import { TsaClient } from '../evidence/tsa.client.js';
import { normalizeDocumentNumber, subjectRef, subjectRefKey } from '../subject-ref.js';
import { CITIZEN_TOKEN_VERIFIER } from './citizen-token-verifier.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
/** A document number no earlier run used: the test database keeps every run's records. */
const newNumber = () => `9${String(randomInt(100_000_000, 999_999_999))}`;

describe('citizen API: who consulted my data (MT-05)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  const valentina = { sub: randomUUID(), number: newNumber() };
  const andres = { sub: randomUUID(), number: newNumber() };
  const refOf = (number: string) =>
    subjectRef({
      key: subjectRefKey(),
      country: 'CO',
      documentType: 'CC',
      documentNumber: normalizeDocumentNumber(number),
    });
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let citizens: TestCitizenIssuer;
  let evidence: TransparencyEvidenceService;
  let versionId = '';
  let subscriptionId = '';

  const call = async (method: 'GET' | 'POST', url: string, who?: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: who ? { authorization: `Bearer ${await issuer.token(subOf(who))}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const asCitizen = (url: string, token: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
    });
  const tokenOf = (citizen: { sub: string; number: string }) =>
    citizens.token(citizen.sub, { documentNumber: citizen.number });

  /** Calls as the gateway registers them (MT-03), about the given person. */
  const consulted = async (number: string, operations: string[], status = '200') => {
    const records = operations.map((operation, i) => ({
      ts: ((Date.now() + i) / 1000).toFixed(3),
      gateway_node: `apisix-${run}`,
      gateway_request_id: hex(16),
      route_id: routeId(versionId),
      operation,
      subscription_id: subscriptionId,
      subject_ref: refOf(number),
      end_user_hash: hex(32),
      status,
      upstream_status: status,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/subject-access',
      headers: { authorization: `Bearer ${process.env.DEN_TRANSPARENCY_INGEST_TOKEN}` },
      payload: records,
    });
    expect(res.json()).toMatchObject({ accepted: operations.length });
  };

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    const salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    const programas = (
      await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } })
    ).id;
    issuer = await createTestIssuer();
    citizens = await createTestCitizenIssuer();
    app = await createTestApp(issuer, [
      { token: CITIZEN_TOKEN_VERIFIER, value: citizens.verifier },
    ]);
    evidence = app.get(TransparencyEvidenceService);

    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `titular-${run}`,
      name: `Afiliación ${run}`,
      summary: 'API para probar la consulta del titular.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      tags: [],
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
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Subsidios ${run}`,
      description: 'Verifica afiliación.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.den.example',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const requested = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar el subsidio X.',
      legalBasisText: 'Ley de protección de datos, artículo 10, literal b.',
      validityMonths: 12,
    });
    subscriptionId = subscriptionDetailSchema.parse(requested.json()).id;
    const approved = await call(
      'POST',
      `/entities/${salud}/access-requests/${subscriptionId}/approve`,
      'lucia.datos',
      { validityMonths: 6 },
    );
    expect(approved.statusCode, approved.body).toBe(200);

    await consulted(valentina.number, ['getAfiliado', 'verificarAfiliacion']);
    await consulted(valentina.number, ['getAfiliado'], '404');
    await consulted(andres.number, ['getAfiliado']);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authentication', () => {
    const path = '/data-subjects/me/accesses';

    it('accepts only a citizen token issued to an authorized citizen app', async () => {
      expect((await call('GET', path)).statusCode).toBe(401);
      // A portal token, even of a platform administrator: 401, not 403.
      expect((await call('GET', path, 'pablo.plataforma')).statusCode).toBe(401);
      const bad = [
        citizens.token(valentina.sub, { documentNumber: valentina.number, foreign: true }),
        citizens.token(valentina.sub, { documentNumber: valentina.number, azp: 'other-app' }),
        citizens.token(valentina.sub, {
          documentNumber: valentina.number,
          audience: 'den-portal-api',
        }),
        citizens.token(valentina.sub, { documentNumber: valentina.number, expiresIn: '-1m' }),
        citizens.token(valentina.sub, { documentNumber: null }),
        citizens.token(valentina.sub, { documentNumber: '12' }),
        citizens.token(valentina.sub, { documentNumber: valentina.number, documentType: 'NIT' }),
      ];
      for (const token of await Promise.all(bad)) {
        const res = await asCitizen(path, token);
        expect(res.statusCode).toBe(401);
        expect(res.headers['content-type']).toMatch(/problem\+json/);
      }
      expect((await asCitizen(path, await tokenOf(valentina))).statusCode).toBe(200);
    });

    it('does not open portal endpoints to a citizen token', async () => {
      const token = await tokenOf(valentina);
      for (const portalPath of ['/me', '/audit/events', '/transparency/verify']) {
        expect((await asCitizen(portalPath, token)).statusCode, portalPath).toBe(401);
      }
    });
  });

  describe('my consultations', () => {
    it('lists who consulted my data, for what and when, newest first', async () => {
      const res = await asCitizen('/data-subjects/me/accesses', await tokenOf(valentina));
      expect(res.statusCode, res.body).toBe(200);
      const page = subjectAccessPageSchema.parse(res.json());
      expect(page.items).toHaveLength(3);
      expect(page.items.map((i) => [i.operation.id, i.status])).toEqual([
        ['getAfiliado', 404],
        ['verificarAfiliacion', 200],
        ['getAfiliado', 200],
      ]);
      expect(page.items[2]).toMatchObject({
        consumer: {
          entity: { shortName: expect.any(String) as string },
          application: `Subsidios ${run}`,
        },
        provider: { shortName: expect.any(String) as string },
        api: { name: `Afiliación ${run}`, version: '1.0' },
        operation: { id: 'getAfiliado', summary: 'Consultar afiliación' },
        purpose: {
          code: 'eligibility_check',
          name: { es: 'Verificación de requisitos de un trámite' },
        },
        data: [{ name: 'regimen', personal: true, sensitive: false }],
        officialRef: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        sealed: false,
      });
      // The number never comes back, not even to its owner.
      expect(res.body).not.toContain(valentina.number);
    });

    it('sees only my own, whatever form my number takes in the token', async () => {
      const andresPage = subjectAccessPageSchema.parse(
        (await asCitizen('/data-subjects/me/accesses', await tokenOf(andres))).json(),
      );
      expect(andresPage.items).toHaveLength(1);
      const formatted = `${valentina.number.slice(0, 1)}.${valentina.number.slice(1, 4)}-${valentina.number.slice(4)}`;
      const samePerson = subjectAccessPageSchema.parse(
        (
          await asCitizen(
            '/data-subjects/me/accesses',
            await citizens.token(randomUUID(), { documentNumber: formatted }),
          )
        ).json(),
      );
      expect(samePerson.items).toHaveLength(3);
      const stranger = subjectAccessPageSchema.parse(
        (
          await asCitizen(
            '/data-subjects/me/accesses',
            await citizens.token(randomUUID(), { documentNumber: newNumber() }),
          )
        ).json(),
      );
      expect(stranger.items).toEqual([]);
    });

    it('pages with an opaque cursor', async () => {
      const token = await tokenOf(valentina);
      const first = subjectAccessPageSchema.parse(
        (await asCitizen('/data-subjects/me/accesses?limit=2', token)).json(),
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = subjectAccessPageSchema.parse(
        (
          await asCitizen(`/data-subjects/me/accesses?limit=2&cursor=${first.nextCursor}`, token)
        ).json(),
      );
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(3);
      expect(
        (await asCitizen('/data-subjects/me/accesses?cursor=not-a-cursor', token)).statusCode,
      ).toBe(400);
    });
  });

  describe('receipts', () => {
    it('gives me a verifiable receipt of my consultation once it is sealed, and nobody else', async () => {
      const token = await tokenOf(valentina);
      const [item] = subjectAccessPageSchema.parse(
        (await asCitizen('/data-subjects/me/accesses?limit=1', token)).json(),
      ).items;
      const path = `/data-subjects/me/accesses/${item?.id}/receipt`;
      expect((await asCitizen(path, token)).statusCode).toBe(409);

      await evidence.sealPending();
      await evidence.stampPending();
      const res = await asCitizen(path, token);
      expect(res.statusCode, res.body).toBe(200);
      const receipt = transparencyReceiptSchema.parse(res.json());
      const result = await verifyReceipt(receipt, {
        jwks: (await call('GET', '/transparency/jwks')).json(),
        tsaRoots: await app.get(TsaClient).certificates(),
      });
      expect(result, JSON.stringify(result)).toMatchObject({ valid: true });
      expect(
        subjectAccessPageSchema.parse(
          (await asCitizen('/data-subjects/me/accesses?limit=1', token)).json(),
        ).items[0]?.sealed,
      ).toBe(true);

      // Andrés cannot get Valentina's receipt, nor learn that it exists.
      expect((await asCitizen(path, await tokenOf(andres))).statusCode).toBe(404);
      expect(
        (await asCitizen(`/data-subjects/me/accesses/${randomUUID()}/receipt`, token)).statusCode,
      ).toBe(404);
    });
  });
});
