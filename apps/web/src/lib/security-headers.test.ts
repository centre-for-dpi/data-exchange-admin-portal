import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  newNonce,
  originOf,
  securityHeaders,
  STATIC_CSP,
} from './security-headers';

const directives = (csp: string) =>
  Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name = '', ...values] = d.split(' ');
      return [name, values];
    }),
  );

describe('web security headers (M3-09)', () => {
  const production = contentSecurityPolicy({
    nonce: 'bm9uY2U=',
    development: false,
    formTargets: ['https://id.example.org'],
    https: true,
  });

  it('allows only scripts with the nonce, and what they load (strict-dynamic)', () => {
    const csp = directives(production);
    expect(csp['script-src']).toEqual(["'self'", "'nonce-bm9uY2U='", "'strict-dynamic'"]);
    expect(production).not.toContain('unsafe-eval');
    expect(csp['script-src']).not.toContain("'unsafe-inline'");
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
  });

  it('forbids framing and sends forms only here and to the identity provider', () => {
    const csp = directives(production);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'self'", 'https://id.example.org']);
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(production).toContain('upgrade-insecure-requests');
  });

  it('relaxes only what next dev needs, and never upgrades on http', () => {
    const dev = contentSecurityPolicy({
      nonce: 'x',
      development: true,
      formTargets: [],
      https: false,
    });
    expect(directives(dev)['script-src']).toContain("'unsafe-eval'");
    expect(directives(dev)['connect-src']).toContain('ws:');
    expect(dev).not.toContain('upgrade-insecure-requests');
  });

  it('gives non-page responses a policy that loads nothing', () => {
    expect(directives(STATIC_CSP)['default-src']).toEqual(["'none'"]);
    expect(directives(STATIC_CSP)['frame-ancestors']).toEqual(["'none'"]);
  });

  it('sends HSTS, nosniff, no framing and a closed permissions policy', () => {
    const headers = Object.fromEntries(securityHeaders().map((h) => [h.key, h.value]));
    expect(headers['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });

  it('makes a different nonce of 128 bits each time', () => {
    const a = newNonce();
    expect(Buffer.from(a, 'base64')).toHaveLength(16);
    expect(newNonce()).not.toBe(a);
  });

  it('reads origins and ignores what is not a URL', () => {
    expect(originOf('http://localhost:8080/realms/x')).toBe('http://localhost:8080');
    expect(originOf('not a url')).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
  });
});
