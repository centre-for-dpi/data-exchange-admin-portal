import { describe, expect, it } from 'vitest';
import { apiEndpoint, ApiError } from './api';

describe('apiEndpoint (B-26)', () => {
  it('builds the URL of an API path with its query', () => {
    expect(apiEndpoint('/catalog/apis/2f2e2a52-0000-4000-8000-000000000001?limit=10')).toMatch(
      /\/api\/v1\/catalog\/apis\/2f2e2a52-0000-4000-8000-000000000001\?limit=10$/,
    );
  });

  it.each([
    '/catalog/apis/../../admin/sync',
    '/catalog/apis/%2e%2e/admin',
    '/catalog/apis/..%2fadmin',
    '/catalog/apis/a%5cb',
    '/catalog/apis/a\b',
    '/catalog/apis/a#b',
    '/catalog//apis',
    '/catalog/apis/a%00',
    'catalog',
  ])('refuses %s', (path) => {
    expect(() => apiEndpoint(path)).toThrow(ApiError);
  });
});
