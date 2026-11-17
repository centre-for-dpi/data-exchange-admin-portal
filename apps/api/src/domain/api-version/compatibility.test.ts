import { describe, expect, it } from 'vitest';
import { breakingChanges } from './compatibility.js';

const base = () => ({
  openapi: '3.1.0',
  info: { title: 'Afiliación', version: '1.0' },
  components: {
    schemas: {
      Afiliado: {
        type: 'object',
        properties: { regimen: { type: 'string' }, activo: { type: 'boolean' } },
      },
    },
  },
  paths: {
    '/afiliados/{numero}': {
      get: {
        operationId: 'consultarAfiliado',
        'x-den-data-subject': { in: 'path', name: 'numero' },
        parameters: [
          { name: 'numero', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'fecha', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Afiliado' } } },
          },
        },
      },
    },
  },
});

type Doc = ReturnType<typeof base>;
const changed = (edit: (d: Doc & Record<string, unknown>) => void) => {
  const d = base() as Doc & Record<string, unknown>;
  edit(d);
  return d;
};
const op = (d: Doc) => d.paths['/afiliados/{numero}'].get as Record<string, unknown>;

describe('OpenAPI compatibility (ADR-0019)', () => {
  it('accepts the same document, text changes, new operations and new response properties', () => {
    expect(breakingChanges(base(), base())).toEqual([]);
    const revision = changed((d) => {
      op(d).summary = 'Consulta mejorada';
      d.components.schemas.Afiliado.properties = {
        ...d.components.schemas.Afiliado.properties,
        eps: { type: 'string' },
      } as typeof d.components.schemas.Afiliado.properties;
      (d.paths as Record<string, unknown>)['/afiliados/{numero}/historial'] = {
        get: { operationId: 'historial', responses: { '200': { description: 'ok' } } },
      };
      (op(d).parameters as unknown[]).push({
        name: 'detalle',
        in: 'query',
        schema: { type: 'boolean' },
      });
    });
    expect(breakingChanges(base(), revision)).toEqual([]);
  });

  it('rejects removed operations and changed operationIds', () => {
    expect(
      breakingChanges(
        base(),
        changed((d) => void (d.paths = {} as Doc['paths'])),
      ),
    ).toEqual(['GET /afiliados/{numero} was removed']);
    expect(
      breakingChanges(
        base(),
        changed((d) => void (op(d).operationId = 'otro')),
      )[0],
    ).toContain('changed its operationId');
  });

  it('rejects new required, newly required and removed parameters', () => {
    const required = changed((d) => {
      (op(d).parameters as unknown[]).push({ name: 'tipo', in: 'query', required: true });
    });
    expect(breakingChanges(base(), required)).toEqual([
      'GET /afiliados/{numero} has a new required parameter query:tipo',
    ]);
    const tightened = changed((d) => {
      (op(d).parameters as Array<Record<string, unknown>>)[1]!.required = true;
    });
    expect(breakingChanges(base(), tightened)).toEqual([
      'GET /afiliados/{numero} made parameter query:fecha required',
    ]);
    const removed = changed((d) => void (op(d).parameters as unknown[]).pop());
    expect(breakingChanges(base(), removed)).toEqual([
      'GET /afiliados/{numero} removed parameter query:fecha',
    ]);
  });

  it('rejects removed or retyped response properties, following $ref', () => {
    const removed = changed((d) => {
      d.components.schemas.Afiliado.properties = {
        regimen: { type: 'string' },
      } as typeof d.components.schemas.Afiliado.properties;
    });
    expect(breakingChanges(base(), removed)).toEqual([
      'GET /afiliados/{numero} 200 removed property activo',
    ]);
    const retyped = changed((d) => {
      d.components.schemas.Afiliado.properties.activo = { type: 'string' };
    });
    expect(breakingChanges(base(), retyped)).toEqual([
      'GET /afiliados/{numero} 200 changed the type of activo',
    ]);
  });

  it('rejects changes to the data subject declaration and to security', () => {
    const subject = changed((d) => void (op(d)['x-den-data-subject'] = 'none'));
    expect(breakingChanges(base(), subject)[0]).toContain('x-den-data-subject');
    const security = changed((d) => void (op(d).security = [{ oauth: [] }]));
    expect(breakingChanges(base(), security)[0]).toContain('security');
  });

  it('judges the data subject and the operations as the gateway reads them', () => {
    // Moving the declaration to the path item looks the same to a lenient reader, but OPA reads
    // operations only: the operation would lose its data subject.
    const moved = changed((d) => {
      const item = d.paths['/afiliados/{numero}'] as Record<string, unknown>;
      item['x-den-data-subject'] = op(d)['x-den-data-subject'];
      delete op(d)['x-den-data-subject'];
    });
    expect(breakingChanges(base(), moved).join(' ')).toContain('x-den-data-subject');
    // A path item behind $ref is not an operation for the gateway.
    const referenced = changed((d) => {
      (d.components as Record<string, unknown>).pathItems = {
        afiliado: d.paths['/afiliados/{numero}'],
      };
      d.paths['/afiliados/{numero}'] = { $ref: '#/components/pathItems/afiliado' } as never;
    });
    expect(breakingChanges(base(), referenced)).not.toEqual([]);
  });

  it('survives reference cycles', () => {
    const cyclic = changed((d) => {
      (d.components.schemas as Record<string, unknown>).Loop = {
        $ref: '#/components/schemas/Loop',
      };
      op(d).responses = {
        '200': {
          description: 'ok',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Loop' } } },
        },
      };
    });
    expect(() => breakingChanges(cyclic, cyclic)).not.toThrow();
  });
});
