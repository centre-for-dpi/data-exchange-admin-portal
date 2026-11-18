import { describe, expect, it } from 'vitest';
import { ValidationError } from '../common/errors.js';
import {
  allowedUpstreamTypes,
  assertUpstreamTypeAllowed,
  disallowedUpstreamTypes,
  xroadConfigured,
} from './upstream-types.js';

const XROAD = {
  DEN_XROAD_SECURITY_SERVER_URL: 'https://ss.example:8443',
  DEN_XROAD_CLIENT: 'XX/GOV/1/DEN',
};

const errorOf = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).errors?.[0];
  }
  throw new Error('expected a ValidationError');
};

describe('upstream types of the deployment (P-04)', () => {
  it('needs both X-Road variables for xroad', () => {
    expect(xroadConfigured(XROAD)).toBe(true);
    expect(xroadConfigured({ DEN_XROAD_CLIENT: XROAD.DEN_XROAD_CLIENT })).toBe(false);
    expect(xroadConfigured({ ...XROAD, DEN_XROAD_SECURITY_SERVER_URL: ' ' })).toBe(false);
    expect(xroadConfigured({})).toBe(false);
  });

  it('allows the country list, xroad only with X-Road settings, node first', () => {
    expect(allowedUpstreamTypes(['node', 'xroad'], {})).toEqual(['node']);
    expect(allowedUpstreamTypes(['xroad', 'node'], XROAD)).toEqual(['node', 'xroad']);
    expect(allowedUpstreamTypes(['direct', 'node'], XROAD)).toEqual(['node', 'direct']);
    expect(allowedUpstreamTypes(['xroad'], {})).toEqual([]);
  });

  it('names the types of a version that are no longer allowed', () => {
    const node = { type: 'node' };
    const direct = { type: 'direct' };
    expect(disallowedUpstreamTypes([node, null], ['node'])).toEqual([]);
    expect(disallowedUpstreamTypes([direct, null], ['node'])).toEqual(['direct']);
    expect(disallowedUpstreamTypes([node, direct], ['node'])).toEqual(['direct']);
    expect(disallowedUpstreamTypes([direct, direct], ['node'])).toEqual(['direct']);
    expect(disallowedUpstreamTypes([{ type: 'xroad' }, direct], ['node'])).toEqual([
      'xroad',
      'direct',
    ]);
    expect(disallowedUpstreamTypes([direct, undefined], ['node', 'direct'])).toEqual([]);
  });

  it('refuses a type the country does not list, and xroad without its settings', () => {
    expect(() => assertUpstreamTypeAllowed('node', 'upstream', ['node'], {})).not.toThrow();
    expect(
      errorOf(() => assertUpstreamTypeAllowed('direct', 'upstream', ['node', 'xroad'], XROAD)),
    ).toMatchObject({
      path: 'upstream.type',
      key: 'upstream_type_not_allowed',
      params: { type: 'direct', allowed: 'node, xroad' },
    });
    expect(
      errorOf(() => assertUpstreamTypeAllowed('xroad', 'sandboxUpstream', ['node', 'xroad'], {})),
    ).toMatchObject({ path: 'sandboxUpstream.type', key: 'xroad_not_configured' });
    expect(
      errorOf(() => assertUpstreamTypeAllowed('xroad', 'upstream', ['node', 'direct'], XROAD)),
    ).toMatchObject({ key: 'upstream_type_not_allowed' });
  });
});
