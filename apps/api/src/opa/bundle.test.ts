import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { type BundleData, buildBundle, pathRegex, tarGz } from './bundle.js';
import { untar } from '../../test/untar.js';
import { readPolicies } from './policy-files.js';

const data = (salt = 'salt-for-tests-0001'): BundleData => ({
  routes: {
    'rid-route-v1': {
      apiVersionId: 'v1',
      classification: 'personal',
      operations: [
        { id: 'getAfiliado', method: 'GET', pathRegex: '^/salud/a/v1/afiliados/[^/]+$' },
      ],
    },
  },
  clients: {},
  config: { endUserHashSalt: salt },
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

describe('buildBundle', () => {
  const policies = readPolicies();

  it('packs the manifest, data.json and the policies without their tests', () => {
    const { archive, revision } = buildBundle(policies, data());
    const entries = untar(archive);
    expect([...entries.keys()]).toEqual(['.manifest', 'data.json', 'rid/authz.rego']);
    expect(JSON.parse(entries.get('.manifest') ?? '{}')).toEqual({
      revision,
      roots: ['rid', 'routes', 'clients', 'config'],
    });
    expect(JSON.parse(entries.get('data.json') ?? '{}')).toEqual(data());
    expect(entries.get('rid/authz.rego')).toContain('package rid.authz');
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
