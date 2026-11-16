import { describe, expect, it } from 'vitest';
import { trustedProxies } from './app.js';

/** Who may set X-Forwarded-For (M6-01): the proxy by address, or a number of hops, or nobody. */
describe('RID_TRUST_PROXY', () => {
  it('trusts nobody when unset, empty or 0', () => {
    expect(trustedProxies(undefined)).toBe(false);
    expect(trustedProxies('')).toBe(false);
    expect(trustedProxies(' 0 ')).toBe(false);
  });

  it("passes the proxy's addresses or networks through", () => {
    expect(trustedProxies('172.30.0.0/16, 10.0.0.5')).toBe('172.30.0.0/16, 10.0.0.5');
  });

  it('a number trusts that many hops', () => {
    const trust = trustedProxies('1');
    expect(typeof trust).toBe('function');
    if (typeof trust !== 'function') return;
    expect(trust('172.30.0.9', 0)).toBe(true);
    expect(trust('203.0.113.7', 1)).toBe(false);
  });
});
