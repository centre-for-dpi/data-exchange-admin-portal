import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpKeycloakUsers } from './keycloak-users.js';

/**
 * P-08 against the local Keycloak (pnpm infra:up): a disabled user can no longer get a token.
 * A throwaway user each run; the seed's demo users are not touched.
 */
describe('HttpKeycloakUsers against Keycloak (P-08)', () => {
  const baseUrl = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const keycloak = HttpKeycloakUsers.fromEnv();
  const username = `demo-probe-${randomUUID().slice(0, 8)}`;
  const password = `Probe-${randomUUID()}`;
  let adminToken = '';
  let userId = '';

  const admin = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}/admin/realms/den-portal${path}`, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // Keycloak's own admin-cli client of the realm, the only one there with the password grant.
  const signIn = () =>
    fetch(`${baseUrl}/realms/den-portal/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username,
        password,
      }),
    });

  beforeAll(async () => {
    const login = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: process.env.KEYCLOAK_ADMIN_USER ?? '',
        password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? '',
      }),
    });
    adminToken = ((await login.json()) as { access_token: string }).access_token;
    const created = await admin('POST', '/users', {
      username,
      email: `${username}@demo.den.example`,
      emailVerified: true,
      enabled: true,
      firstName: 'Demo',
      lastName: 'Probe',
      credentials: [{ type: 'password', value: password, temporary: false }],
    });
    expect(created.status).toBe(201);
    userId = created.headers.get('location')?.split('/').at(-1) ?? '';
  });
  afterAll(async () => {
    if (userId) await admin('DELETE', `/users/${userId}`);
  });

  it('disables the user, keeps its profile, and it can no longer sign in', async () => {
    expect(keycloak).toBeDefined();
    expect((await signIn()).status).toBe(200);
    expect(await keycloak?.state(userId)).toBe('enabled');

    expect(await keycloak?.disable(userId)).toBe('disabled');
    expect(await keycloak?.state(userId)).toBe('disabled');
    const user = (await (await admin('GET', `/users/${userId}`)).json()) as Record<string, unknown>;
    expect(user).toMatchObject({ enabled: false, firstName: 'Demo', lastName: 'Probe' });
    expect((await signIn()).status).toBe(400);

    expect(await keycloak?.disable(userId)).toBe('unchanged');
    expect(await keycloak?.state(randomUUID())).toBe('missing');
  });
});
