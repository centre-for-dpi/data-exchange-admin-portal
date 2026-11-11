import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIdentifierLike, lintOpenApi } from './openapi-lint.js';

const mockSpec = (provider: string) =>
  readFileSync(
    resolve(import.meta.dirname, `../../../../../infra/mock-providers/${provider}/openapi.yaml`),
    'utf8',
  );

const minimal = (extra = '') => `openapi: 3.1.0
info:
  title: Test
  version: 1.0.0
paths:
  /things/{thingId}:
    get:
      operationId: getThing
      parameters:
        - name: thingId
          in: path
          required: true
          schema: { type: string }
${extra}      responses:
        '200':
          description: ok
`;

describe('OpenAPI lint (RID ruleset)', () => {
  it.each(['salud', 'socioeconomico'])(
    'accepts the %s mock provider document',
    async (provider) => {
      const result = await lintOpenApi(mockSpec(provider), { noIdInQuery: true });
      expect(result.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(result.report.valid).toBe(true);
      expect(result.operations.length).toBeGreaterThan(0);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it('lists operations with method and path', async () => {
    const result = await lintOpenApi(mockSpec('salud'), { noIdInQuery: true });
    expect(result.operations).toEqual([
      { operationId: 'getAfiliado', method: 'GET', path: '/afiliados/{numeroIdentificacion}' },
      { operationId: 'verificarAfiliacion', method: 'POST', path: '/afiliados/verificaciones' },
    ]);
  });

  it('requires an operationId, with the line of the operation', async () => {
    const source = minimal().replace('      operationId: getThing\n', '');
    const { report } = await lintOpenApi(source, { noIdInQuery: true });
    expect(report.valid).toBe(false);
    const issue = report.issues.find((i) => i.code === 'operation-operationId');
    expect(issue?.line).toBe(7);
  });

  it('requires a success response', async () => {
    const source = minimal().replace(
      "        '200':\n          description: ok\n",
      "        '404':\n          description: no\n",
    );
    const { report } = await lintOpenApi(source, { noIdInQuery: true });
    expect(report.issues.map((i) => i.code)).toContain('operation-success-response');
  });

  it('rejects identifiers in the query string when the country requires it', async () => {
    const withQuery = minimal(`        - name: numeroDocumento
          in: query
          schema: { type: string }
`);
    const strict = await lintOpenApi(withQuery, { noIdInQuery: true });
    const issue = strict.report.issues.find((i) => i.code === 'rid-no-id-in-query');
    expect(issue?.severity).toBe('error');
    expect(issue?.line).toBe(14);
    const lenient = await lintOpenApi(withQuery, { noIdInQuery: false });
    expect(lenient.report.issues.map((i) => i.code)).not.toContain('rid-no-id-in-query');
  });

  it('allows harmless query parameters', async () => {
    const withQuery = minimal(`        - name: limit
          in: query
          schema: { type: integer }
`);
    const { report } = await lintOpenApi(withQuery, { noIdInQuery: true });
    expect(report.valid).toBe(true);
  });

  it('reports YAML syntax errors and non-OpenAPI-3 documents', async () => {
    const broken = await lintOpenApi('openapi: 3.1.0\ninfo: [unclosed\n', { noIdInQuery: true });
    expect(broken.report.valid).toBe(false);
    const swagger = await lintOpenApi(
      'swagger: "2.0"\ninfo: {title: x, version: "1"}\npaths: {}\n',
      {
        noIdInQuery: true,
      },
    );
    expect(swagger.report.issues.map((i) => i.code)).toContain('rid-openapi-3');
  });

  it('accepts JSON as well as YAML', async () => {
    const json = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      paths: {
        '/x': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } } } },
      },
    });
    const { report, operations } = await lintOpenApi(json, { noIdInQuery: true });
    expect(report.valid).toBe(true);
    expect(operations).toEqual([{ operationId: 'getX', method: 'GET', path: '/x' }]);
  });
});

describe('identifier-like parameter names', () => {
  it.each([
    'id',
    'personId',
    'person_id',
    'numeroDocumento',
    'documentNumber',
    'identificacion',
    'doc',
    'tax-id',
    'user.ids',
  ])('flags %s', (name) => expect(isIdentifierLike(name)).toBe(true));
  it.each([
    'limit',
    'valid',
    'paid',
    'unidad',
    'syntax',
    'grid',
    'fecha',
    'idioma',
    'page',
    'sort',
  ])('does not flag %s', (name) => expect(isIdentifierLike(name)).toBe(false));
});
