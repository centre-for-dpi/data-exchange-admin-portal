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

describe('OpenAPI lint (DEN ruleset)', () => {
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

  it('lists operations with method, path and data subject', async () => {
    const result = await lintOpenApi(mockSpec('salud'), { noIdInQuery: true });
    expect(result.operations).toEqual([
      {
        operationId: 'getAfiliado',
        method: 'GET',
        path: '/afiliados/{numeroIdentificacion}',
        dataSubject: { in: 'path', name: 'numeroIdentificacion', documentType: 'CC' },
      },
      {
        operationId: 'verificarAfiliacion',
        method: 'POST',
        path: '/afiliados/verificaciones',
        dataSubject: { in: 'body', pointer: '/numeroIdentificacion', documentType: 'CC' },
      },
    ]);
  });

  describe('data subject (x-den-data-subject, ADR-0015)', () => {
    const personal = {
      noIdInQuery: true,
      dataSubject: { required: true, documentTypes: ['CC', 'CE', 'TI'] },
    };
    const withSubject = (yaml: string) =>
      minimal().replace(
        '      operationId: getThing\n',
        `      operationId: getThing\n${yaml
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n')}\n`,
      );
    const codes = async (source: string, options = personal) =>
      (await lintOpenApi(source, options)).report.issues.map((i) => i.code);

    it('requires a declaration on every operation of a personal-data API', async () => {
      const { report } = await lintOpenApi(minimal(), personal);
      const issue = report.issues.find((i) => i.code === 'den-data-subject-required');
      expect(issue).toMatchObject({ severity: 'error', line: 7 }); // the operation's line
      expect(issue?.message).toContain('getThing');
      // APIs without personal data may omit it.
      expect(
        await codes(minimal(), {
          ...personal,
          dataSubject: { ...personal.dataSubject, required: false },
        }),
      ).toEqual([]);
    });

    it('accepts a path parameter or none', async () => {
      for (const yaml of [
        'x-den-data-subject:\n  in: path\n  name: thingId',
        'x-den-data-subject:\n  in: path\n  name: thingId\n  documentType: CE',
        'x-den-data-subject: none',
      ]) {
        expect(await codes(withSubject(yaml)), yaml).toEqual([]);
      }
      const { operations } = await lintOpenApi(withSubject('x-den-data-subject: none'), personal);
      expect(operations[0]?.dataSubject).toEqual({ in: 'none' });
    });

    describe('in the body, read by the gateway (ADR-0017)', () => {
      const post = (subject: string) => `openapi: 3.1.0
info:
  title: Test
  version: 1.0.0
paths:
  /checks:
    post:
      operationId: check
${subject
  .split('\n')
  .map((l) => `      ${l}`)
  .join('\n')}
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object }
      responses:
        '200':
          description: ok
`;

      it('accepts a JSON pointer, with a fixed or a body document type', async () => {
        for (const yaml of [
          'x-den-data-subject:\n  in: body\n  pointer: /numeroIdentificacion',
          'x-den-data-subject:\n  in: body\n  pointer: /persona/numero\n  documentType: CE',
          'x-den-data-subject:\n  in: body\n  pointer: /persona/numero\n  documentTypePointer: /persona/tipo',
        ]) {
          expect(await codes(post(yaml)), yaml).toEqual([]);
        }
        const { operations } = await lintOpenApi(
          post('x-den-data-subject:\n  in: body\n  pointer: /persona/numero'),
          personal,
        );
        expect(operations[0]?.dataSubject).toEqual({ in: 'body', pointer: '/persona/numero' });
      });

      it('rejects bad pointers, both type sources, and operations without a JSON body', async () => {
        expect(
          await codes(post('x-den-data-subject:\n  in: body\n  pointer: numeroIdentificacion')),
        ).toEqual(['den-data-subject-pointer']);
        expect(
          await codes(
            post(
              'x-den-data-subject:\n  in: body\n  pointer: /n\n  documentType: CC\n  documentTypePointer: /t',
            ),
          ),
        ).toEqual(['den-data-subject-invalid']);
        expect(
          await codes(withSubject('x-den-data-subject:\n  in: body\n  pointer: /numero')),
        ).toEqual(['den-data-subject-body']);
      });
    });

    it('rejects parameters that are not in the path and unknown document types', async () => {
      expect(await codes(withSubject('x-den-data-subject:\n  in: path\n  name: cedula'))).toEqual([
        'den-data-subject-parameter',
      ]);
      expect(
        await codes(
          withSubject(
            'x-den-data-subject:\n  in: path\n  name: thingId\n  documentTypeParam: tipo',
          ),
        ),
      ).toEqual(['den-data-subject-parameter']);
      expect(
        await codes(
          withSubject(
            'x-den-data-subject:\n  in: path\n  name: thingId\n  documentType: PASAPORTE',
          ),
        ),
      ).toEqual(['den-data-subject-document-type']);
    });

    it('rejects malformed declarations, which then count as undeclared', async () => {
      for (const yaml of [
        'x-den-data-subject: thingId',
        'x-den-data-subject:\n  in: query\n  name: thingId',
        'x-den-data-subject:\n  in: path',
        // The consumer-declared header (before ADR-0017) is no longer accepted.
        'x-den-data-subject:\n  in: header',
      ]) {
        const result = await lintOpenApi(withSubject(yaml), personal);
        expect(
          result.report.issues.map((i) => i.code),
          yaml,
        ).toEqual(['den-data-subject-invalid']);
        expect(result.operations[0]?.dataSubject).toBeNull();
      }
    });
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
    const issue = strict.report.issues.find((i) => i.code === 'den-no-id-in-query');
    expect(issue?.severity).toBe('error');
    expect(issue?.line).toBe(14);
    const lenient = await lintOpenApi(withQuery, { noIdInQuery: false });
    expect(lenient.report.issues.map((i) => i.code)).not.toContain('den-no-id-in-query');
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
    expect(swagger.report.issues.map((i) => i.code)).toContain('den-openapi-3');
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
    expect(operations).toEqual([
      { operationId: 'getX', method: 'GET', path: '/x', dataSubject: null },
    ]);
  });
});

describe('paths a request could match twice (M-13)', () => {
  /** A document with one operation per (path, method); path parameters are declared. */
  const withPaths = (paths: Array<[path: string, method?: string]>) =>
    [
      'openapi: 3.1.0',
      'info: { title: Test, version: 1.0.0 }',
      'paths:',
      ...paths.flatMap(([path, method = 'get'], i) => [
        `  ${path}:`,
        `    ${method}:`,
        `      operationId: op${i}`,
        ...([...path.matchAll(/\{([^/{}]+)\}/g)].length > 0
          ? [
              '      parameters:',
              ...[...path.matchAll(/\{([^/{}]+)\}/g)].map(
                (m) =>
                  `        - { name: ${m[1]}, in: path, required: true, schema: { type: string } }`,
              ),
            ]
          : []),
        "      responses: { '200': { description: ok } }",
      ]),
    ].join('\n');
  const ambiguous = async (paths: Array<[string, string?]>) =>
    (await lintOpenApi(withPaths(paths), { noIdInQuery: false })).report.issues.filter(
      (i) => i.code === 'den-ambiguous-paths',
    );

  it('accepts a literal path next to a parameterised one: the literal wins at the gateway', async () => {
    const { report } = await lintOpenApi(
      withPaths([['/afiliados/{afiliadoId}'], ['/afiliados/buscar']]),
      { noIdInQuery: false },
    );
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(await ambiguous([['/archivos/{nombre}'], ['/archivos/{nombre}.json']])).toEqual([]);
  });

  it('rejects overlapping paths where neither is more specific', async () => {
    const issues = await ambiguous([['/a/{x}/c'], ['/{y}/b/c']]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', path: ['paths', '/{y}/b/c'] });
    expect(issues[0]?.message).toContain('/a/{x}/c');
    expect(await ambiguous([['/f/{a}.json'], ['/f/x{b}']])).toHaveLength(1);
  });

  it('accepts what cannot meet: other methods, other literals, other lengths', async () => {
    expect(
      await ambiguous([
        ['/a/{x}', 'get'],
        ['/{y}/b', 'post'],
      ]),
    ).toEqual([]);
    expect(await ambiguous([['/a/{x}/c'], ['/{y}/b/d']])).toEqual([]);
    expect(await ambiguous([['/f/{a}.json'], ['/f/{b}.xml']])).toEqual([]);
    expect(await ambiguous([['/a/{x}'], ['/{y}/b/c']])).toEqual([]);
  });

  it('leaves equivalent templates to Spectral (path-params)', async () => {
    const { report } = await lintOpenApi(withPaths([['/a/{x}'], ['/a/{y}']]), {
      noIdInQuery: false,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('path-params');
    expect(report.issues.map((i) => i.code)).not.toContain('den-ambiguous-paths');
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
