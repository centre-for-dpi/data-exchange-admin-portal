import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ESTADOS_AFILIACION,
  FIRST_ID,
  GRUPOS,
  PERSON_COUNT,
  generateAfiliados,
  generateHogares,
} from './data.js';
import { PROVIDERS, parseProvider, type Provider } from './providers.js';
import { buildServer, openapiPath, traceHeaders } from './server.js';

interface OpenApiDoc {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, unknown> };
}
interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ in?: string; $ref?: string }>;
  responses: Record<string, unknown>;
}

const loadSpec = (provider: Provider): OpenApiDoc =>
  parse(readFileSync(openapiPath(provider), 'utf8')) as OpenApiDoc;

/** Validator for a component schema of the provider's own OpenAPI document. */
function schemaValidator(provider: Provider, schema: string) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema({ $id: 'spec', components: loadSpec(provider).components });
  return ajv.compile({ $ref: `spec#/components/schemas/${schema}` });
}

const SAMPLE_ID = String(FIRST_ID);
const UNKNOWN_ID = '999999999';

describe('synthetic data', () => {
  it.each([
    ['afiliados', generateAfiliados],
    ['hogares', generateHogares],
  ] as const)('generates %s for exactly 1.000 synthetic identifiers', (_name, generate) => {
    const records = generate();
    expect(records.size).toBe(PERSON_COUNT);
    expect(records.has(String(FIRST_ID))).toBe(true);
    expect(records.has(String(FIRST_ID + PERSON_COUNT - 1))).toBe(true);
    expect(records.has(String(FIRST_ID + PERSON_COUNT))).toBe(false);
  });

  it('is deterministic across runs', () => {
    expect([...generateAfiliados()]).toEqual([...generateAfiliados()]);
    expect([...generateHogares()]).toEqual([...generateHogares()]);
  });

  it('covers every category so all demo scenarios have data', () => {
    const estados = new Set([...generateAfiliados().values()].map((a) => a.estado));
    expect([...estados].sort()).toEqual([...ESTADOS_AFILIACION].sort());
    const grupos = new Set([...generateHogares().values()].map((h) => h.grupo));
    expect([...grupos].sort()).toEqual([...GRUPOS]);
  });
});

describe.each(PROVIDERS)('OpenAPI of %s', (provider) => {
  const spec = loadSpec(provider);
  const operations = Object.values(spec.paths).flatMap((methods) => Object.values(methods));

  it('gives every operation an operationId, summary and description', () => {
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) {
      expect(op.operationId).toMatch(/^[a-z][A-Za-z]+$/);
      expect(op.summary).toBeTruthy();
      expect(op.description).toBeTruthy();
    }
  });

  it('never takes parameters in the query string (lint.noIdInQuery)', () => {
    for (const op of operations) {
      expect((op.parameters ?? []).filter((p) => p.in === 'query')).toEqual([]);
    }
  });

  it('defines a success response for every operation', () => {
    for (const op of operations) {
      expect(Object.keys(op.responses).some((code) => code.startsWith('2'))).toBe(true);
    }
  });
});

describe('mock provider: salud', () => {
  const app = buildServer('salud');
  afterEach(() => undefined);

  it('returns an affiliation that matches the OpenAPI schema', async () => {
    const res = await app.inject({ method: 'GET', url: `/afiliados/${SAMPLE_ID}` });
    expect(res.statusCode).toBe(200);
    const validate = schemaValidator('salud', 'Afiliado');
    expect(validate(res.json()), JSON.stringify(validate.errors)).toBe(true);
  });

  it('also serves under its service path, like a node of the kit', async () => {
    const prefixed = await app.inject({ method: 'GET', url: `/salud/afiliados/${SAMPLE_ID}` });
    const root = await app.inject({ method: 'GET', url: `/afiliados/${SAMPLE_ID}` });
    expect(prefixed.statusCode).toBe(200);
    expect(prefixed.json()).toEqual(root.json());
  });

  it('answers 404 problem+json for an unknown identifier', async () => {
    const res = await app.inject({ method: 'GET', url: `/afiliados/${UNKNOWN_ID}` });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(schemaValidator('salud', 'Problema')(res.json())).toBe(true);
  });

  it('answers 400 problem+json for a malformed identifier', async () => {
    const res = await app.inject({ method: 'GET', url: '/afiliados/abc' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('verifies an affiliation with the identifier in the body', async () => {
    const active = [...generateAfiliados().values()].find((a) => a.estado === 'activo');
    const inactive = [...generateAfiliados().values()].find((a) => a.estado !== 'activo');
    const validate = schemaValidator('salud', 'ResultadoVerificacion');
    for (const [id, expected] of [
      [active?.numeroIdentificacion, true],
      [inactive?.numeroIdentificacion, false],
      [UNKNOWN_ID, false],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/afiliados/verificaciones',
        payload: { numeroIdentificacion: id },
      });
      expect(res.statusCode).toBe(200);
      expect(validate(res.json())).toBe(true);
      expect(res.json()).toEqual({ afiliadoActivo: expected });
    }
  });

  it('rejects verification requests with extra or missing fields', async () => {
    for (const payload of [{}, { numeroIdentificacion: SAMPLE_ID, nombre: 'x' }]) {
      const res = await app.inject({ method: 'POST', url: '/afiliados/verificaciones', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('serves its OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(readFileSync(openapiPath('salud'), 'utf8'));
  });
});

describe('mock provider: socioeconomico', () => {
  const app = buildServer('socioeconomico');

  it('returns a household that matches the OpenAPI schema', async () => {
    const res = await app.inject({ method: 'GET', url: `/hogares/${SAMPLE_ID}` });
    expect(res.statusCode).toBe(200);
    const validate = schemaValidator('socioeconomico', 'Hogar');
    expect(validate(res.json()), JSON.stringify(validate.errors)).toBe(true);
  });

  it('answers 404 for an unknown identifier and does not expose salud routes', async () => {
    expect((await app.inject({ method: 'GET', url: `/hogares/${UNKNOWN_ID}` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: `/afiliados/${SAMPLE_ID}` })).statusCode).toBe(
      404,
    );
  });
});

describe('request logging', () => {
  function captureLogs(): { stream: Writable; lines: string[] } {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    return { stream, lines };
  }

  it('logs the gateway trace headers but never the identifier or the response', async () => {
    const { stream, lines } = captureLogs();
    const app = buildServer('salud', { logStream: stream });
    await app.inject({
      method: 'GET',
      url: `/afiliados/${SAMPLE_ID}?extra=1`,
      headers: {
        'x-rid-consumer-entity': 'programas-sociales',
        'x-rid-purpose': 'eligibility_check',
        'x-rid-operation': 'getAfiliado',
        'x-rid-end-user': '52123456',
        'x-request-id': 'req-123',
        authorization: 'Bearer secret-token',
      },
    });
    const output = lines.join('');
    expect(output).toContain('"x-rid-consumer-entity":"programas-sociales"');
    expect(output).toContain('"x-rid-purpose":"eligibility_check"');
    expect(output).toContain('"x-request-id":"req-123"');
    expect(output).toContain('"route":"/afiliados/:numeroIdentificacion"');
    expect(output).not.toContain(SAMPLE_ID);
    expect(output).not.toContain('52123456');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('extra=1');
    expect(output).not.toMatch(/regimen|aseguradora/);
  });

  it('masks the end-user header and ignores unrelated headers', () => {
    expect(
      traceHeaders({
        'x-rid-end-user': '123',
        'x-rid-data-subject': 'CC:1000000001',
        'x-rid-purpose': 'p',
        cookie: 'c',
        host: 'h',
      }),
    ).toEqual({
      'x-rid-end-user': '[masked]',
      'x-rid-data-subject': '[masked]',
      'x-rid-purpose': 'p',
    });
  });
});

describe('parseProvider', () => {
  it('rejects an unknown provider', () => {
    expect(() => parseProvider('banco')).toThrow(/PROVIDER must be one of/);
    expect(() => parseProvider(undefined)).toThrow(/PROVIDER must be one of/);
  });
});
