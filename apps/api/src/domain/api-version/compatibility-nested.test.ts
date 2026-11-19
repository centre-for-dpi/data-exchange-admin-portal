import { describe, expect, it } from 'vitest';
import { breakingChanges } from './compatibility.js';

/**
 * Changes a consumer built against the published document would break
 * on, which the compatibility check of ADR-0019 lets through as a "compatible revision" (no
 * operator review, same route, same subscriptions).
 */
const doc = (over: {
  paramType?: string;
  nested?: Record<string, unknown>;
  bodyProps?: Record<string, unknown>;
  itemsProps?: Record<string, unknown>;
}) => ({
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  paths: {
    '/personas/{id}': {
      get: {
        operationId: 'getPersona',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: over.paramType ?? 'string' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    afiliacion: {
                      type: 'object',
                      properties: over.nested ?? {
                        regimen: { type: 'string' },
                        estado: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/personas': {
      get: {
        operationId: 'listPersonas',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: over.itemsProps ?? { nombre: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'buscarPersona',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['numero'],
                properties: over.bodyProps ?? { numero: { type: 'string' } },
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

describe('compatibility check (ADR-0019) compares nested schemas', () => {
  it('sanity: an identical document has no breaking changes', () => {
    expect(breakingChanges(doc({}), doc({}))).toEqual([]);
  });

  it('flags a nested response property that was removed', () => {
    const revision = doc({ nested: { regimen: { type: 'string' } } }); // `estado` is gone
    expect(breakingChanges(doc({}), revision)).not.toEqual([]);
  });

  it('flags a nested response property that changed type', () => {
    const revision = doc({ nested: { regimen: { type: 'integer' }, estado: { type: 'string' } } });
    expect(breakingChanges(doc({}), revision)).not.toEqual([]);
  });

  it('flags a property removed from the items of an array response', () => {
    const revision = doc({ itemsProps: { apodo: { type: 'string' } } }); // `nombre` is gone
    expect(breakingChanges(doc({}), revision)).not.toEqual([]);
  });

  it('flags a parameter that changed type', () => {
    expect(breakingChanges(doc({}), doc({ paramType: 'integer' }))).not.toEqual([]);
  });

  it('flags a required request-body property that changed type', () => {
    const revision = doc({ bodyProps: { numero: { type: 'integer' } } });
    expect(breakingChanges(doc({}), revision)).not.toEqual([]);
  });
});

describe('compatibility check: what it cannot compare is incompatible', () => {
  const composed = (alt: string) => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/x': {
        get: {
          operationId: 'x',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { oneOf: [{ type: 'string' }, { type: alt }] },
                },
              },
            },
          },
        },
      },
    },
  });

  it('accepts identical composed schemas and flags a changed one', () => {
    expect(breakingChanges(composed('integer'), composed('integer'))).toEqual([]);
    expect(breakingChanges(composed('integer'), composed('boolean'))).not.toEqual([]);
  });

  it('flags a response that stops being always returned', () => {
    const withRequired = (required: string[]) => ({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          get: {
            operationId: 'x',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'object', required, properties: { a: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(breakingChanges(withRequired(['a']), withRequired([]))).not.toEqual([]);
  });
});

describe('compatibility check: documents built to make it explode', () => {
  /** Level i references level i+1 three times: 3^25 paths when expanded, 25 pairs when decided. */
  const bomb = (leaf: string) => {
    const schemas: Record<string, unknown> = {};
    const levels = 25;
    for (let i = 0; i < levels; i++) {
      const next = { $ref: `#/components/schemas/L${i + 1}` };
      schemas[`L${i}`] = { type: 'object', properties: { a: next, b: next, c: next } };
    }
    schemas[`L${levels}`] = { type: leaf };
    return {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      components: { schemas },
      paths: {
        '/x': {
          get: {
            operationId: 'x',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/L0' } } },
              },
            },
          },
        },
      },
    };
  };
  const composedBomb = (leaf: string) => {
    const doc = bomb(leaf);
    (
      doc.paths['/x'].get.responses['200'].content['application/json'] as Record<string, unknown>
    ).schema = {
      allOf: [{ $ref: '#/components/schemas/L0' }],
    };
    return doc;
  };

  it('finishes quickly and stays conservative', () => {
    const started = Date.now();
    expect(breakingChanges(bomb('string'), bomb('string'))).toEqual([]);
    expect(breakingChanges(bomb('string'), bomb('integer')).length).toBeGreaterThan(0);
    expect(breakingChanges(composedBomb('string'), composedBomb('string'))).toEqual([]);
    expect(breakingChanges(composedBomb('string'), composedBomb('integer')).length).toBeGreaterThan(
      0,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports a document beyond the work budget as too complex', () => {
    // Distinct schemas at every level: nothing to share, so the budget stops it.
    const wide = (n: number) => {
      const schemas: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        schemas[`S${i}`] = {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 50 }, (_, k) => [
              `p${k}`,
              { type: 'string', description: `${i}` },
            ]),
          ),
        };
      }
      return {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: {
          '/x': {
            get: {
              operationId: 'x',
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: Object.fromEntries(
                          Array.from({ length: n }, (_, i) => [
                            `s${i}`,
                            { $ref: `#/components/schemas/S${i}` },
                          ]),
                        ),
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: { schemas },
      };
    };
    expect(breakingChanges(wide(5000), wide(5000))).toEqual([
      'The schemas are too complex to compare',
    ]);
  });
});

describe('compatibility check: shared work never skips a break', () => {
  const shared = (leaf: string, inlineLeaf: string) => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    components: { schemas: { Dato: { type: 'object', properties: { v: { type: leaf } } } } },
    paths: {
      '/a': {
        get: {
          operationId: 'a',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Dato' } } },
            },
          },
        },
      },
      '/b': {
        get: {
          operationId: 'b',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { v: { type: inlineLeaf } } },
                },
              },
            },
          },
        },
      },
    },
  });

  it('flags an inline schema that breaks although the same reference was inlined identically elsewhere', () => {
    // Published: /a by reference, /b inline, both with v: string. Revision: /a still fine,
    // /b inline with v: integer.
    const published = shared('string', 'string');
    const revision = shared('string', 'integer');
    const problems = breakingChanges(published, revision);
    expect(problems.some((p) => p.startsWith('GET /b'))).toBe(true);
  });

  it('reports a break of a reference pair at every path that uses it', () => {
    const twice = (leaf: string) => {
      const doc = shared(leaf, leaf);
      const route = doc.paths['/b'].get.responses['200'].content['application/json'];
      (route as { schema: unknown }).schema = { $ref: '#/components/schemas/Dato' };
      return doc;
    };
    const problems = breakingChanges(twice('string'), twice('integer'));
    expect(problems.filter((p) => p.startsWith('GET /a'))).not.toEqual([]);
    expect(problems.filter((p) => p.startsWith('GET /b'))).not.toEqual([]);
  });
});
