import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('AUTH_SECRET', 'matcher-test-secret-0123456789abcdef0123');
vi.stubEnv('DEN_PORTAL_WEB_CLIENT_SECRET', 'x');
const { config } = await import('./proxy');

const matcher = new RegExp(`^${config.matcher[0]}$`);

describe('proxy matcher (B-26)', () => {
  it.each([
    '/',
    '/es',
    '/en/catalog',
    '/catalog/some.id',
    '/my-apis/v1.2/versions',
    '/kit',
    '/en/kit',
  ])('runs for %s', (path) => expect(matcher.test(path)).toBe(true));

  it.each([
    '/api/auth/session',
    '/branding/logo',
    '/files/entity-check.sh',
    '/_next/static/chunk.js',
    '/kit/0.2.0/den-kit-0.2.0.tar.gz',
    '/favicon.ico',
    '/robots.txt',
    '/fonts/outfit.woff2',
  ])('does not run for %s', (path) => expect(matcher.test(path)).toBe(false));
});
