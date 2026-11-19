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
import { HttpApisixAdmin } from '../reconcilers/apisix/apisix-admin.js';
import { ApisixReconciler } from '../reconcilers/apisix/apisix.reconciler.js';
import {
  checkRouteId,
  checkRoutePath,
  sandboxCheckRouteId,
  sandboxCheckRoutePath,
  versionCheckToken,
} from '../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { hostControlToken } from '../reconcilers/apisix/desired-state.js';
import {
  GatewayValidationProbes,
  type ValidationProbes,
  VersionValidationService,
} from './version-validation.service.js';

const GATEWAY = `http://127.0.0.1:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const TOKEN = `m4-06-validation-${randomUUID()}`;
const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

/**
 * Validations at submission (M4-06) against the real APISIX: the check routes of a version in
 * review (narrow, behind the validation token), the healthcheck through them, and, when a
 * contract runner is configured (DEN_CONTRACT_RUNNER_URL), Schemathesis against the sandbox.
 * The operator's gate is tested with fixed probe results.
 */
describe('validations when a version goes to review (M4-06)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  const saved: Record<string, string | undefined> = {};
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      DEN_VERSION_VALIDATION: 'on',
      DEN_VALIDATION_TOKEN: TOKEN,
      DEN_GATEWAY_INTERNAL_URL: GATEWAY,
      // Asking again is limited (MB-2); these tests ask often, the limit has its own test.
      DEN_VALIDATION_COOLDOWN_SECONDS: '0',
      DEN_VALIDATION_MAX_PER_HOUR: '100000',
      // The runner (if any) runs on the host in development and reaches APISIX there.
      DEN_CONTRACT_RUNNER_GATEWAY_URL: process.env.DEN_CONTRACT_RUNNER_GATEWAY_URL ?? GATEWAY,
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
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
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const request = async (method: 'GET' | 'POST', url: string, username: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(sub(username))}` },
      ...(payload ? { payload } : method === 'POST' ? { payload: {} } : {}),
    });

  /** A version of salud on the development node, with the same node as sandbox, in review. */
  async function submitted(sandbox = true) {
    const slug = `valida-${randomUUID().slice(0, 8)}`;
    const api = apiDetailSchema.parse(
      (
        await request('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
          slug,
          name: `Validaciones ${slug}`,
          summary: 'Consulta el estado de afiliación de una persona.',
          description: 'API de prueba de las validaciones al enviar a revisión.',
          sector: 'salud',
          classification: 'personal',
          ownerContact: 'apis@salud.demo.den.example',
        })
      ).json(),
    );
    const created = await request(
      'POST',
      `/entities/${salud}/apis/${api.id}/versions`,
      'pedro.publicador',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        ...(sandbox ? { sandboxUpstream: { type: 'node', servicePath: '/salud' } } : {}),
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
        allowedPurposes: ['eligibility_check'],
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    const version = apiVersionDetailSchema.parse(created.json());
    const res = await request(
      'POST',
      `/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`,
      'pedro.publicador',
    );
    expect(res.statusCode, res.body).toBe(200);
    return {
      apiId: api.id,
      versionId: version.id,
      detail: apiVersionDetailSchema.parse(res.json()),
    };
  }

  it('submitting marks the validations running and queues them with the check routes', async () => {
    const { versionId, detail } = await submitted();
    expect(detail.validation).toMatchObject({ status: 'running', healthcheck: null });
    const queued = await prisma.outboxMessage.findMany({
      where: { aggregate: `apiVersion:${versionId}` },
      select: { topic: true },
    });
    expect(queued.map((q) => q.topic).sort()).toEqual(['gateway.sync', 'version.validate']);
  });

  it('check routes only answer the validation token; the production one only GET on the root', async () => {
    const { versionId } = await submitted();
    await app.get(ApisixReconciler).reconcileVersion(versionId);
    expect(await admin.get('routes', checkRouteId(versionId))).toBeDefined();
    expect(await admin.get('routes', sandboxCheckRouteId(versionId))).toBeDefined();
    const health = `${GATEWAY}${checkRoutePath(versionId)}`;
    // Each version has its own token: the global one opens nothing.
    const own = versionCheckToken(TOKEN, versionId);
    const sandbox = `${GATEWAY}${sandboxCheckRoutePath(versionId)}/afiliados/1000000001`;
    let ok = 0;
    for (let i = 0; i < 40 && ok !== 200; i += 1) {
      ok = (await fetch(sandbox, { headers: { 'x-den-validation': own } })).status;
      if (ok !== 200) await new Promise((r) => setTimeout(r, 250));
    }
    expect(ok).toBe(200);
    // Without the token the routes do not exist, nor with the global token or another version's.
    expect((await fetch(health)).status).toBe(404);
    for (const other of [TOKEN, versionCheckToken(TOKEN, randomUUID())]) {
      expect((await fetch(health, { headers: { 'x-den-validation': other } })).status).toBe(404);
    }
    expect((await fetch(sandbox, { headers: { 'x-den-validation': 'otro' } })).status).toBe(404);
    // The production upstream: GET on the service root only, never a data path.
    expect((await fetch(health, { headers: { 'x-den-validation': own } })).status).toBeLessThan(
      500,
    );
    expect(
      (await fetch(`${health}/afiliados/1000000001`, { headers: { 'x-den-validation': own } }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(health, { method: 'POST', headers: { 'x-den-validation': own } })).status,
    ).toBe(404);

    // The healthcheck through the route passes; the contract test runs if a runner is set.
    const report = await app.get(VersionValidationService).run(versionId);
    expect(report?.healthcheck).toMatchObject({ status: 'passed' });
    if (process.env.DEN_CONTRACT_RUNNER_URL) {
      expect(report?.contract?.status).not.toBe('error');
      expect(report?.contract?.operations.map((o) => o.operation).sort()).toEqual([
        'GET /afiliados/{numeroIdentificacion}',
        'POST /afiliados/verificaciones',
      ]);
    } else {
      expect(report?.contract).toMatchObject({ status: 'skipped' });
    }
    // Nothing but parsed results is kept: no body of the sandbox in the report.
    const stored = await prisma.apiVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(JSON.stringify(stored.validationReport)).not.toMatch(/regimen|curl|afiliadoActivo/);

    // Out of review, the check routes go.
    await prisma.apiVersion.updateMany({ where: { id: versionId }, data: { status: 'draft' } });
    await app.get(ApisixReconciler).reconcileVersion(versionId);
    expect(await admin.get('routes', checkRouteId(versionId))).toBeUndefined();
    expect(await admin.get('routes', sandboxCheckRouteId(versionId))).toBeUndefined();
  });

  const fixed = (health: 'passed' | 'failed', contract: 'passed' | 'failed'): ValidationProbes => ({
    healthcheck: () =>
      Promise.resolve({
        status: health,
        httpStatus: health === 'passed' ? 200 : 502,
        latencyMs: 5,
      }),
    contract: () =>
      Promise.resolve({
        status: contract,
        operations: [
          {
            operation: 'POST /afiliados/verificaciones',
            passed: contract === 'passed',
            codes: contract === 'passed' ? [] : ['ST101'],
            receivedStatus: contract === 'passed' ? null : 500,
          },
        ],
      }),
  });

  it('the operator approves only after the validations passed; the provider can run them again', async () => {
    const { apiId, versionId } = await submitted();
    const approve = () =>
      request('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {});
    // Still running: a 409 that says why (P-07), not a generic conflict.
    const pending = await approve();
    expect(pending.statusCode).toBe(409);
    expect(pending.headers['content-type']).toContain('application/problem+json');
    expect(pending.json()).toMatchObject({
      code: 'conflict',
      errors: [{ path: '', key: 'validations_pending' }],
    });

    const validation = app.get(VersionValidationService);
    await validation.run(versionId, fixed('passed', 'failed'));
    const failed = await approve();
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toMatchObject({
      code: 'conflict',
      errors: [{ path: '', key: 'validations_failed' }],
    });
    expect(failed.json<{ detail: string }>().detail).toContain('failed');
    // Refused: still in review, and no approval recorded.
    const still = await prisma.apiVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(still.status).toBe('in_review');
    expect(
      await prisma.auditEvent.count({
        where: { targetId: versionId, action: { startsWith: 'api_version.approved' } },
      }),
    ).toBe(0);
    const audited = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: versionId, action: 'api_version.validated' },
    });
    expect(audited.after).toMatchObject({
      status: 'failed',
      contract: 'failed',
      failedOperations: 1,
    });

    // The provider fixes the service and asks again: running, then passed.
    const again = await request(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/validations`,
      'pedro.publicador',
    );
    expect(again.statusCode, again.body).toBe(200);
    expect(apiVersionDetailSchema.parse(again.json()).validation?.status).toBe('running');
    await validation.run(versionId, fixed('passed', 'passed'));
    const approved = await approve();
    expect(approved.statusCode, approved.body).toBe(200);
  });

  it('a failed healthcheck blocks; a version without sandbox skips the contract test', async () => {
    const { versionId } = await submitted(false);
    const validation = app.get(VersionValidationService);
    const report = await validation.run(versionId, fixed('failed', 'passed'));
    expect(report).toMatchObject({ status: 'failed', contract: { status: 'skipped' } });
    const ok = await validation.run(versionId, fixed('passed', 'failed'));
    expect(ok).toMatchObject({ status: 'passed', contract: { status: 'skipped' } });
  });
  it('asking again is limited by a cooldown per version and a cap per entity (MB-2)', async () => {
    const { apiId, versionId } = await submitted();
    const again = () =>
      request(
        'POST',
        `/entities/${salud}/apis/${apiId}/versions/${versionId}/validations`,
        'pedro.publicador',
      );
    const settings = ['DEN_VALIDATION_COOLDOWN_SECONDS', 'DEN_VALIDATION_MAX_PER_HOUR'] as const;
    const before = settings.map((k) => process.env[k]);
    try {
      process.env.DEN_VALIDATION_COOLDOWN_SECONDS = '300';
      const tooSoon = await again();
      expect(tooSoon.statusCode, tooSoon.body).toBe(429);
      expect(tooSoon.json()).toMatchObject({
        code: 'rate_limited',
        errors: [{ key: 'validation_rate_limited' }],
      });
      process.env.DEN_VALIDATION_COOLDOWN_SECONDS = '0';
      process.env.DEN_VALIDATION_MAX_PER_HOUR = '0';
      expect((await again()).statusCode).toBe(429);
      process.env.DEN_VALIDATION_MAX_PER_HOUR = '100000';
      expect((await again()).statusCode).toBe(200);
    } finally {
      settings.forEach((k, i) => {
        if (before[i] === undefined) delete process.env[k];
        else process.env[k] = before[i];
      });
    }
    // Other members cannot ask, nor other entities reach it.
    const url = `/entities/${salud}/apis/${apiId}/versions/${versionId}/validations`;
    expect((await request('POST', url, 'lucia.datos')).statusCode).toBe(403);
    expect((await request('POST', url, 'carlos.dev')).statusCode).toBe(404);
  });

  it('a direct sandbox host must prove it is the provider’s before the contract test runs (MB-2)', async () => {
    const { apiId, versionId } = await submitted();
    await prisma.apiVersion.update({
      where: { id: versionId },
      data: {
        sandboxUpstream: {
          type: 'direct',
          url: 'https://sandbox.proveedor.example/api',
          mtls: false,
        },
      },
    });
    const validation = app.get(VersionValidationService);
    let contractRuns = 0;
    const probes = (proven: boolean): ValidationProbes => ({
      ...fixed('passed', 'passed'),
      hostControl: () => Promise.resolve(proven),
      contract: () => {
        contractRuns += 1;
        return fixed('passed', 'passed').contract(versionId, {});
      },
    });
    const refused = await validation.run(versionId, probes(false));
    expect(refused).toMatchObject({
      status: 'failed',
      contract: { status: 'failed', reason: 'host control not proven' },
    });
    expect(contractRuns).toBe(0);
    expect(await validation.run(versionId, probes(true))).toMatchObject({ status: 'passed' });
    expect(contractRuns).toBe(1);

    // The provider reads what to serve; it is bound to the entity and the host.
    const proof = await request(
      'GET',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/host-proof`,
      'pedro.publicador',
    );
    expect(proof.json()).toEqual({
      required: true,
      url: 'https://sandbox.proveedor.example/.well-known/den-validation',
      token: hostControlToken(TOKEN, salud, 'sandbox.proveedor.example'),
    });
    expect(hostControlToken(TOKEN, salud, 'sandbox.proveedor.example')).not.toBe(
      hostControlToken(TOKEN, randomUUID(), 'sandbox.proveedor.example'),
    );
    // The real probe never calls a host that resolves to an internal address.
    expect(
      await new GatewayValidationProbes().hostControl(salud, {
        type: 'direct',
        url: 'https://127.0.0.1/api',
        mtls: false,
      }),
    ).toBe(false);
    expect(
      (
        await request(
          'GET',
          `/entities/${salud}/apis/${apiId}/versions/${versionId}/host-proof`,
          'carlos.dev',
        )
      ).statusCode,
    ).toBe(404);
  });
});
