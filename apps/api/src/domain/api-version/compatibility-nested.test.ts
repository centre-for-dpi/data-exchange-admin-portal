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
