import { describe, expect, it } from 'vitest';
import { trustedProxies } from './app.js';

/** Who may set X-Forwarded-For (M6-01): the proxy by address, or a number of hops, or nobody. */
describe('DEN_TRUST_PROXY', () => {
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

describe('DEN_TRUST_PROXY with host names (M-27)', () => {
  type Trust = ((address: string, hop: number) => boolean) & { refresh: () => Promise<void> };
  const resolver = (table: Record<string, string[]>) => (name: string) =>
    table[name] ? Promise.resolve(table[name]) : Promise.reject(new Error('ENOTFOUND'));

  it('trusts the addresses the names resolve to, and the fixed ones', async () => {
    const table: Record<string, string[]> = {
      edge: ['172.20.0.2'],
      web: ['172.18.0.7', '172.20.0.9'],
    };
    const trust = trustedProxies('edge, web, 10.1.0.0/16', resolver(table)) as Trust;
    expect(typeof trust).toBe('function');
    await trust.refresh();
    expect(trust('172.20.0.2', 0)).toBe(true);
    expect(trust('::ffff:172.18.0.7', 0)).toBe(true);
    expect(trust('10.1.2.3', 0)).toBe(true);
    expect(trust('203.0.113.7', 1)).toBe(false);
    // The web recreated by Compose: its new address once the names are resolved again.
    table.web = ['172.18.0.12'];
    await trust.refresh();
    expect(trust('172.18.0.12', 0)).toBe(true);
    expect(trust('172.18.0.7', 0)).toBe(false);
  });

  it('a name that does not resolve trusts nothing, and bad entries are refused', async () => {
    const trust = trustedProxies('missing', resolver({})) as Trust;
    await trust.refresh();
    expect(trust('172.20.0.2', 0)).toBe(false);
    expect(() => trustedProxies('edge, bad name!', resolver({}))).toThrow(/bad name!/);
  });
});
