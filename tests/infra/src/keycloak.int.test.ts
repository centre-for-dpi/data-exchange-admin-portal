import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from './env.js';
import {
  audiences,
  carpetaClient,
  clientCredentialsToken,
  decodeJwt,
  keycloakUrl,
  loginWithAuthorizationCode,
  webUrl,
} from './keycloak.js';
import { fromRoot } from './paths.js';

const seedUsers = (
  JSON.parse(readFileSync(fromRoot('infra/keycloak/rid-portal-realm.json'), 'utf8')) as {
    users: Array<{ id: string; username: string }>;
  }
).users;

describe('realm rid-portal (M0-03)', () => {
  const password = env('RID_DEMO_USER_PASSWORD', 'demo');

  it.each(seedUsers)('$username logs in through apps/web (code + PKCE)', async (user) => {
    const result = await loginWithAuthorizationCode(user.username, password);
    expect(result.tokens, result.page?.slice(0, 200)).toBeDefined();

    const claims = decodeJwt(result.tokens?.access_token ?? '');
    expect(claims.iss).toBe(`${keycloakUrl()}/realms/rid-portal`);
    expect(claims.sub).toBe(user.id);
    expect(claims.azp).toBe('rid-portal-web');
    expect(audiences(claims)).toContain('rid-portal-api');
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('rejects a wrong password', async () => {
    const result = await loginWithAuthorizationCode('carlos.dev', 'wrong-password');
    expect(result.tokens).toBeUndefined();
    expect(result.redirect).toBeUndefined();
  });

  it('requires PKCE', async () => {
    const result = await loginWithAuthorizationCode('carlos.dev', password, { pkce: false });
    expect(result.tokens).toBeUndefined();
    expect(result.redirect?.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses redirect URIs outside the web app', async () => {
    const result = await loginWithAuthorizationCode('carlos.dev', password, {
      redirectUri: 'https://attacker.example/callback',
    });
    expect(result.tokens).toBeUndefined();
    expect(result.redirect).toBeUndefined();
  });

  it('does not allow the password grant on rid-portal-web', async () => {
    const res = await fetch(`${keycloakUrl()}/realms/rid-portal/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'rid-portal-web',
        client_secret: env('RID_PORTAL_WEB_CLIENT_SECRET'),
        username: 'carlos.dev',
        password,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized_client');
  });

  it('serves its discovery document with the browser-facing issuer', async () => {
    const res = await fetch(`${keycloakUrl()}/realms/rid-portal/.well-known/openid-configuration`);
    const discovery = (await res.json()) as { issuer: string };
    expect(discovery.issuer).toBe(`${keycloakUrl()}/realms/rid-portal`);
    expect(webUrl()).toMatch(/^https?:\/\//);
  });
});

describe('realm rid-gateway (M0-03)', () => {
  const admin = `${keycloakUrl()}/admin/realms`;
  let provisionerToken: string;
  const appClientId = `rid-app-${randomUUID()}`;
  let appInternalId: string | undefined;

  const asProvisioner = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${admin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${provisionerToken}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });

  beforeAll(async () => {
    const res = await clientCredentialsToken(
      'rid-gateway',
      env('RID_GATEWAY_PROVISIONER_CLIENT_ID', 'rid-portal-provisioner'),
      env('RID_GATEWAY_PROVISIONER_SECRET'),
    );
    expect(res.status).toBe(200);
    provisionerToken = ((await res.json()) as { access_token: string }).access_token;
  });

  afterAll(async () => {
    if (appInternalId)
      await asProvisioner(`/rid-gateway/clients/${appInternalId}`, { method: 'DELETE' });
  });

  it('lets the portal provisioner create an application client', async () => {
    const res = await asProvisioner('/rid-gateway/clients', {
      method: 'POST',
      body: JSON.stringify({
        clientId: appClientId,
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
      }),
    });
    expect(res.status).toBe(201);
    appInternalId = res.headers.get('location')?.split('/').pop();
    expect(appInternalId).toBeTruthy();
  });

  it('issues minimal 5-minute application tokens with the rid-gateway audience', async () => {
    const secretRes = await asProvisioner(`/rid-gateway/clients/${appInternalId}/client-secret`);
    const { value: secret } = (await secretRes.json()) as { value: string };

    const tokenRes = await clientCredentialsToken('rid-gateway', appClientId, secret);
    expect(tokenRes.status).toBe(200);
    const claims = decodeJwt(((await tokenRes.json()) as { access_token: string }).access_token);

    expect(claims.iss).toBe(`${keycloakUrl()}/realms/rid-gateway`);
    expect(audiences(claims)).toEqual(['rid-gateway']);
    expect(claims.azp).toBe(appClientId);
    expect(claims.client_id).toBe(appClientId);
    expect(claims.sub).toBeTruthy();
    expect(claims.exp - claims.iat).toBe(300);
    // No profile, email, role or client network claims leak into gateway tokens.
    for (const claim of [
      'email',
      'preferred_username',
      'realm_access',
      'resource_access',
      'clientAddress',
      'clientHost',
    ]) {
      expect(claims, claim).not.toHaveProperty(claim);
    }
  });

  it('confines the provisioner to clients of rid-gateway', async () => {
    expect((await asProvisioner('/rid-gateway/users')).status).toBe(403);
    expect((await asProvisioner('/rid-gateway/roles')).status).toBe(403);
    expect((await asProvisioner('/rid-portal/clients')).status).toBe(403);
    expect((await asProvisioner('/master/clients')).status).toBe(403);
  });
});

const citizens = (
  JSON.parse(readFileSync(fromRoot('infra/keycloak/rid-citizens-realm.json'), 'utf8')) as {
    users: Array<{ id: string; username: string; attributes: Record<string, string[]> }>;
  }
).users;

describe('realm rid-citizens (MT-05)', () => {
  const password = env('RID_DEMO_USER_PASSWORD', 'demo');

  it.each(citizens)(
    '$username logs in to the Carpeta and its token carries the verified document only',
    async (citizen) => {
      const result = await loginWithAuthorizationCode(citizen.username, password, {
        client: carpetaClient(),
      });
      expect(result.tokens, result.page?.slice(0, 200)).toBeDefined();
      const claims = decodeJwt(result.tokens?.access_token ?? '');
      expect(claims.iss).toBe(`${keycloakUrl()}/realms/rid-citizens`);
      expect(claims.sub).toBe(citizen.id);
      expect(claims.azp).toBe('carpeta-ciudadana');
      expect(audiences(claims)).toEqual(['rid-transparency-api']);
      expect(claims.document_type).toBe(citizen.attributes.document_type?.[0]);
      expect(claims.document_number).toBe(citizen.attributes.document_number?.[0]);
      // Nothing else about the person travels to the portal.
      for (const claim of ['email', 'name', 'given_name', 'family_name', 'realm_access']) {
        expect(claims).not.toHaveProperty(claim);
      }
    },
  );

  it('does not allow the password grant on the Carpeta client', async () => {
    const client = carpetaClient();
    const res = await fetch(`${keycloakUrl()}/realms/rid-citizens/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: client.clientId,
        client_secret: client.clientSecret,
        username: 'ciudadana.demo',
        password,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses redirect URIs outside the Carpeta', async () => {
    const result = await loginWithAuthorizationCode('ciudadana.demo', password, {
      client: carpetaClient(),
      redirectUri: 'https://attacker.example/callback',
    });
    expect(result.tokens).toBeUndefined();
  });
});
