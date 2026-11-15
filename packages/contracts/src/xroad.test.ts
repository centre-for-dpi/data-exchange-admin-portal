import { describe, expect, it } from 'vitest';
import { upstreamSchema, xroadPartSchema, xroadServicePath } from './apis.js';

describe('X-Road identifiers (M4-05, SPIKE S-5)', () => {
  it('accepts letters, digits, spaces inside and . _ - : ~', () => {
    for (const part of ['GOV', '8999999999', 'REGISTRO SOCIAL-Ñ', 'v1.consulta_hogar', 'a:b~c']) {
      expect(xroadPartSchema.safeParse(part).success, part).toBe(true);
    }
  });

  it('refuses what could change the URL the gateway builds', () => {
    for (const part of ['a/b', '%2F', 'a?b', 'a#b', '$1', ' lead', 'trail ', '', 'tab\tx']) {
      expect(xroadPartSchema.safeParse(part).success, JSON.stringify(part)).toBe(false);
    }
  });

  it('builds the PR-REST r1 path, with or without subsystem', () => {
    const id = {
      instance: 'CO',
      memberClass: 'GOV',
      memberCode: '8999999999',
      subsystemCode: 'REGISTRO',
      serviceCode: 'consultaHogar',
    };
    expect(xroadServicePath(id)).toBe('/r1/CO/GOV/8999999999/REGISTRO/consultaHogar');
    const { subsystemCode: _s, ...noSubsystem } = id;
    expect(xroadServicePath(noSubsystem)).toBe('/r1/CO/GOV/8999999999/consultaHogar');
  });

  it('an xroad upstream holds only the service id and a path: no Security Server URL', () => {
    const base = {
      type: 'xroad',
      serviceId: { instance: 'CO', memberClass: 'GOV', memberCode: '1', serviceCode: 's' },
    };
    expect(upstreamSchema.parse(base)).toMatchObject({ servicePath: '' });
    expect(
      upstreamSchema.safeParse({ ...base, securityServerUrl: 'https://ss.example' }).success,
    ).toBe(false);
  });
});
