import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  type BundleData,
  buildBundle,
  bundleSubject,
  pathRegex,
  pathSpecificity,
  tarGz,
} from './bundle.js';
import { untar } from '../../test/untar.js';
import { readPolicies } from './policy-files.js';

const data = (salt = 'salt-for-tests-0001'): BundleData => ({
  routes: {
    'den-route-v1': {
      apiVersionId: 'v1',
      classification: 'personal',
      operations: [
        { id: 'getAfiliado', method: 'GET', pathRegex: '^/salud/a/v1/afiliados/[^/]+$' },
      ],
    },
  },
  clients: {},
  config: {
    endUserHashSalt: salt,
    subjectRefKey: 'subject-key-for-tests-0000000000000001',
    country: 'XX',
    documentTypes: ['ID', 'PP'],
    mtlsRequired: false,
    gatewayNodes: 1,
  },
});

describe('bundleSubject (where OPA finds the data subject, ADR-0015)', () => {
  it('captures the subject path parameter, numbering groups by their order in the path', () => {
    const subject = bundleSubject('/salud/a/v1', '/afiliados/{numero}', {
      in: 'path',
      name: 'numero',
      documentType: 'ID',
    });
    expect(subject).toEqual({
      in: 'path',
      regex: '^/salud/a/v1/afiliados/([^/]+)$',
      numberGroup: 1,
      documentType: 'ID',
    });
    const match = new RegExp(subject?.in === 'path' ? subject.regex : '').exec(
      '/salud/a/v1/afiliados/1000000001',
    );
    expect(match?.[1]).toBe('1000000001');
  });

  it('captures the document type parameter too, and leaves other parameters uncaptured', () => {
    const subject = bundleSubject('/r/p/v1', '/{region}/personas/{tipo}/{numero}', {
      in: 'path',
      name: 'numero',
      documentTypeParam: 'tipo',
    });
    expect(subject).toEqual({
      in: 'path',
      regex: '^/r/p/v1/[^/]+/personas/([^/]+)/([^/]+)$',
      numberGroup: 2,
      typeGroup: 1,
    });
  });

  it('keeps body pointers with the gateway plugin; undeclared operations get nothing', () => {
    // OPA only reads what the plugin extracted: the pointers do not go into the bundle.
    expect(
      bundleSubject('/a/b/v1', '/x', { in: 'body', pointer: '/persona/id', documentType: 'PP' }),
    ).toEqual({ in: 'body', documentType: 'PP' });
    expect(bundleSubject('/a/b/v1', '/x', { in: 'none' })).toEqual({ in: 'none' });
    expect(bundleSubject('/a/b/v1', '/x', null)).toBeUndefined();
  });
});

describe('pathRegex (operations on the full public path, SPIKE S-1)', () => {
  it('anchors the base path and turns each template parameter into one segment', () => {
    const regex = pathRegex('/salud/afiliacion/v1', '/afiliados/{numeroIdentificacion}');
    expect(regex).toBe('^/salud/afiliacion/v1/afiliados/[^/]+$');
    const re = new RegExp(regex);
    expect(re.test('/salud/afiliacion/v1/afiliados/1000000001')).toBe(true);
    expect(re.test('/salud/afiliacion/v1/afiliados/1/otro')).toBe(false);
    expect(re.test('/salud/afiliacion/v1/afiliados/')).toBe(false);
  });

  it('escapes literal characters and accepts parameters inside a segment', () => {
    const regex = pathRegex('/salud/a.b/v1', '/x+y/{id}.json');
    expect(regex).toBe(String.raw`^/salud/a\.b/v1/x\+y/[^/]+\.json$`);
    const re = new RegExp(regex);
    expect(re.test('/salud/a.b/v1/x+y/1000.json')).toBe(true);
    expect(re.test('/salud/aXb/v1/x+y/1000.json')).toBe(false);
    expect(re.test('/salud/a.b/v1/x+y/1000Xjson')).toBe(false);
    expect(re.test('/salud/a.b/v1/x+y/a/b.json')).toBe(false);
  });
});

describe("pathSpecificity (the policy's precedence, M-13)", () => {
  it('ranks each segment: literal, partly a parameter, a parameter', () => {
    expect(pathSpecificity(pathRegex('/s/a/v1', '/afiliados/buscar'))).toBe('222222');
    expect(pathSpecificity(pathRegex('/s/a/v1', '/afiliados/{id}.json'))).toBe('222221');
    expect(pathSpecificity(pathRegex('/s/a/v1', '/afiliados/{id}'))).toBe('222220');
    // Escaped braces in a literal are not a parameter.
    expect(pathSpecificity(pathRegex('/s/a/v1', '/x{}'))).toBe('22222');
  });
});

describe('buildBundle', () => {
  const policies = readPolicies();

  it('packs the manifest, data.json and the policies without their tests', () => {
    const { archive, revision } = buildBundle(policies, data());
    const entries = untar(archive);
    expect([...entries.keys()]).toEqual(['.manifest', 'data.json', 'den/authz.rego']);
    expect(JSON.parse(entries.get('.manifest') ?? '{}')).toEqual({
      revision,
      roots: ['den', 'routes', 'clients', 'config'],
    });
    expect(JSON.parse(entries.get('data.json') ?? '{}')).toEqual(data());
    expect(entries.get('den/authz.rego')).toContain('package den.authz');
  });

  it('is reproducible: same content, same archive and revision; any change, a new one', () => {
    const a = buildBundle(policies, data());
    const b = buildBundle(policies, data());
    expect(b.revision).toBe(a.revision);
    expect(b.archive.equals(a.archive)).toBe(true);
    expect(buildBundle(policies, data('another-salt-0001')).revision).not.toBe(a.revision);
  });

  it('pads entries to 512-byte blocks and ends with two empty blocks', () => {
    const tar = gunzipSync(tarGz([{ name: 'a.txt', content: 'hola' }]));
    expect(tar.length).toBe(512 * 4);
  });
});
