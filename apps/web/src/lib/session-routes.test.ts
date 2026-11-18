import { describe, expect, it } from 'vitest';
import { homePathFor, requiresSession } from './session-routes';

describe('requiresSession', () => {
  it.each([
    '/operator',
    '/es/operator',
    '/en/operator/entities',
    '/notifications',
    '/my-apps/0190a000-0000-7000-8000-000000000000',
    '/en/my-apis/new',
    '/my-entity',
    '/regulator/indicators',
    '/audit',
    '/requests',
    '/entity-requests/new',
    '/invitations',
  ])('%s needs a session', (path) => {
    expect(requiresSession(path)).toBe(true);
  });

  it.each(['/', '/en', '/es', '/catalog', '/en/catalog/abc', '/unknown', '/operatorx'])(
    '%s is reachable without a session',
    (path) => {
      expect(requiresSession(path)).toBe(false);
    },
  );
});

describe('homePathFor', () => {
  it('uses the prefix-less home for the default locale and /en for English', () => {
    expect(homePathFor('/operator')).toBe('/');
    expect(homePathFor('/es/operator')).toBe('/');
    expect(homePathFor('/en/operator')).toBe('/en');
  });
});
