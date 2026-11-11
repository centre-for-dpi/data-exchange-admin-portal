import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, visibleNavItems, type Viewer } from './navigation';

const keys = (viewer: Viewer, publicCatalog = false) =>
  visibleNavItems(viewer, { publicCatalog }).map((i) => i.key);

describe('role-based navigation', () => {
  it('shows only the home page to anonymous users', () => {
    expect(keys({ authenticated: false, roles: [] })).toEqual(['home']);
  });

  it('adds the catalogue for anonymous users when the public catalogue is enabled', () => {
    expect(keys({ authenticated: false, roles: [] }, true)).toEqual(['home', 'catalog']);
  });

  it('shows the catalogue to any signed-in user, even without roles', () => {
    expect(keys({ authenticated: true, roles: [] })).toEqual(['home', 'catalog']);
  });

  it('shows the data steward inbox only to data stewards', () => {
    expect(keys({ authenticated: true, roles: ['data_steward'] })).toContain('requests');
    expect(keys({ authenticated: true, roles: ['app_developer'] })).not.toContain('requests');
  });

  it('shows the operator console to platform staff and the regulator view to the regulator', () => {
    expect(keys({ authenticated: true, roles: ['platform_reviewer'] })).toContain('operator');
    expect(keys({ authenticated: true, roles: ['regulator'] })).toEqual([
      'home',
      'catalog',
      'regulator',
      'audit',
    ]);
  });

  it('gives an app developer the entity, apps and catalogue entries only', () => {
    expect(keys({ authenticated: true, roles: ['app_developer'] })).toEqual([
      'home',
      'catalog',
      'myEntity',
      'myApps',
    ]);
  });

  it('uses unique keys and hrefs', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });
});
