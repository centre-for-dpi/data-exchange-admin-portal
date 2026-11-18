import { describe, expect, it, vi } from 'vitest';
import { HttpKeycloakUsers } from './keycloak-users.js';

/** A fake Keycloak: the master token, and the users of den-portal by id. */
function fakeKeycloak(users: Record<string, Record<string, unknown>>) {
  const calls: string[] = [];
  const fetchFn = vi.fn((input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/realms/master/protocol/openid-connect/token') {
      const body = new URLSearchParams(init?.body);
      return Promise.resolve(
        body.get('password') === 'secret'
          ? Response.json({ access_token: 'admin-token', expires_in: 60 })
          : new Response('', { status: 401 }),
      );
    }
    const match = /^\/admin\/realms\/den-portal\/users\/([^/]+)(\/logout)?$/.exec(url.pathname);
    const user = match ? users[match[1] ?? ''] : undefined;
    if (!user) return Promise.resolve(new Response('', { status: 404 }));
    if (match?.[2]) return Promise.resolve(new Response(null, { status: 204 }));
    if (method === 'PUT') {
      Object.assign(user, JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(Response.json(user));
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const client = (fetchFn: typeof fetch, password = 'secret') =>
  new HttpKeycloakUsers({ baseUrl: 'http://kc', username: 'admin', password, fetchFn });

describe('HttpKeycloakUsers (P-08)', () => {
  it('disables an enabled user, keeping the rest of it, and ends its sessions', async () => {
    const users = { u1: { id: 'u1', username: 'pablo', enabled: true, firstName: 'Pablo' } };
    const { fetchFn, calls } = fakeKeycloak(users);
    const keycloak = client(fetchFn);
    expect(await keycloak.state('u1')).toBe('enabled');
    expect(await keycloak.disable('u1')).toBe('disabled');
    expect(users.u1).toEqual({ id: 'u1', username: 'pablo', enabled: false, firstName: 'Pablo' });
    expect(calls).toContain('POST /admin/realms/den-portal/users/u1/logout');
    expect(await keycloak.state('u1')).toBe('disabled');
  });

  it('is idempotent: a disabled user is not written again, its sessions still end', async () => {
    const { fetchFn, calls } = fakeKeycloak({ u1: { id: 'u1', enabled: false } });
    expect(await client(fetchFn).disable('u1')).toBe('unchanged');
    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
    expect(calls).toContain('POST /admin/realms/den-portal/users/u1/logout');
  });

  it('says when the realm does not have the user', async () => {
    const { fetchFn } = fakeKeycloak({});
    expect(await client(fetchFn).state('nobody')).toBe('missing');
    expect(await client(fetchFn).disable('nobody')).toBe('missing');
  });

  it('fails when the administrator cannot log in', async () => {
    const { fetchFn } = fakeKeycloak({ u1: { id: 'u1', enabled: true } });
    await expect(client(fetchFn, 'wrong').state('u1')).rejects.toThrow(/admin login failed/);
  });

  it('is built from the environment only with the administrator credentials', () => {
    expect(HttpKeycloakUsers.fromEnv({ KEYCLOAK_URL: 'http://kc' })).toBeUndefined();
    expect(
      HttpKeycloakUsers.fromEnv({
        KEYCLOAK_URL: 'http://kc/auth/',
        KEYCLOAK_ADMIN_USER: 'admin',
        KEYCLOAK_ADMIN_PASSWORD: 'x',
      }),
    ).toBeInstanceOf(HttpKeycloakUsers);
  });
});
