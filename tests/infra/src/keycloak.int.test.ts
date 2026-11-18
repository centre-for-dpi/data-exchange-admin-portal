import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from './env.js';
import {
  audiences,
  citizenAppClient,
  clientCredentialsToken,
  CookieJar,
  decodeJwt,
  demoTotpSecret,
  keycloakUrl,
  loginWithAuthorizationCode,
  totp,
  webUrl,
} from './keycloak.js';
import { fromRoot } from './paths.js';

const seedUsers = (
  JSON.parse(readFileSync(fromRoot('infra/keycloak/den-portal-realm.json'), 'utf8')) as {
    users: Array<{ id: string; username: string }>;
  }
).users;

describe('realm den-portal (M0-03)', () => {
  const password = env('DEN_DEMO_USER_PASSWORD', 'den-demo-password');

  it.each(seedUsers)('$username logs in through apps/web (code + PKCE)', async (user) => {
    const result = await loginWithAuthorizationCode(user.username, password);
    expect(result.tokens, result.page?.slice(0, 200)).toBeDefined();

    const claims = decodeJwt(result.tokens?.access_token ?? '');
    expect(claims.iss).toBe(`${keycloakUrl()}/realms/den-portal`);
    expect(claims.sub).toBe(user.id);
    expect(claims.azp).toBe('den-portal-web');
    expect(audiences(claims)).toContain('den-portal-api');
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

  it('does not allow the password grant on den-portal-web', async () => {
    const res = await fetch(`${keycloakUrl()}/realms/den-portal/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'den-portal-web',
        client_secret: env('DEN_PORTAL_WEB_CLIENT_SECRET'),
        username: 'carlos.dev',
        password,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized_client');
  });

  it('serves its discovery document with the browser-facing issuer', async () => {
    const res = await fetch(`${keycloakUrl()}/realms/den-portal/.well-known/openid-configuration`);
    const discovery = (await res.json()) as { issuer: string };
    expect(discovery.issuer).toBe(`${keycloakUrl()}/realms/den-portal`);
    expect(webUrl()).toMatch(/^https?:\/\//);
  });

  it('gives the e-mail verification link an hour (P-08; scripts/keycloak-portal-mfa.mjs)', async () => {
    const login = await fetch(`${keycloakUrl()}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: env('KEYCLOAK_ADMIN_USER'),
        password: env('KEYCLOAK_ADMIN_PASSWORD'),
      }),
    });
    const { access_token: adminToken } = (await login.json()) as { access_token: string };
    const realm = (await (
      await fetch(`${keycloakUrl()}/admin/realms/den-portal`, {
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json()) as { actionTokenGeneratedByUserLifespan?: number };
    expect(realm.actionTokenGeneratedByUserLifespan).toBe(3600);
  });
});

describe('realm den-portal: second factor (M3-08)', () => {
  const password = env('DEN_DEMO_USER_PASSWORD', 'den-demo-password');
  const tokenUrl = `${keycloakUrl()}/realms/den-portal/protocol/openid-connect/token`;
  /** Keycloak accepts each code once, and the codes of the periods next to this one. */
  const used = new Set<string>();
  const nextCode = (username: string) => {
    for (const offset of [0, 30_000, -30_000]) {
      const code = totp(demoTotpSecret(), Date.now() + offset);
      if (!used.has(`${username}:${code}`)) {
        used.add(`${username}:${code}`);
        return code;
      }
    }
    throw new Error('no unused one-time code left in this period');
  };

  it('a password login has acr=password; asking for acr=mfa then only asks the code', async () => {
    const jar = new CookieJar();
    const first = await loginWithAuthorizationCode('lucia.datos', password, { jar });
    expect(first.forms).toEqual(['kc-form-login']);
    expect(decodeJwt(first.tokens?.access_token ?? '').acr).toBe('password');

    const stepUp = await loginWithAuthorizationCode('lucia.datos', password, {
      jar,
      acr: 'mfa',
      otp: nextCode('lucia.datos'),
    });
    expect(stepUp.forms).toEqual(['kc-otp-login-form']);
    expect(decodeJwt(stepUp.tokens?.access_token ?? '').acr).toBe('mfa');

    // The web refreshes every 5 minutes: the refreshed token keeps the level.
    const refreshed = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stepUp.tokens?.refresh_token ?? '',
        client_id: 'den-portal-web',
        client_secret: env('DEN_PORTAL_WEB_CLIENT_SECRET'),
      }),
    });
    expect(refreshed.status).toBe(200);
    const { access_token: accessToken } = (await refreshed.json()) as { access_token: string };
    expect(decodeJwt(accessToken).acr).toBe('mfa');
  });

  it('a fresh login with acr=mfa asks the password and then the code', async () => {
    const result = await loginWithAuthorizationCode('marta.regulador', password, {
      acr: 'mfa',
      otp: nextCode('marta.regulador'),
    });
    expect(result.forms).toEqual(['kc-form-login', 'kc-otp-login-form']);
    expect(decodeJwt(result.tokens?.access_token ?? '').acr).toBe('mfa');
  });

  it('refuses a wrong code and a code already used', async () => {
    const wrong = String((Number(totp(demoTotpSecret())) + 1) % 1_000_000).padStart(6, '0');
    const refused = await loginWithAuthorizationCode('sofia.auditora', password, {
      acr: 'mfa',
      otp: wrong,
    });
    expect(refused.tokens).toBeUndefined();
    expect(refused.page).toContain('kc-otp-login-form');

    const code = nextCode('sofia.auditora');
    const first = await loginWithAuthorizationCode('sofia.auditora', password, {
      acr: 'mfa',
      otp: code,
    });
    expect(first.tokens).toBeDefined();
    const replay = await loginWithAuthorizationCode('sofia.auditora', password, {
      acr: 'mfa',
      otp: code,
    });
    expect(replay.tokens).toBeUndefined();
  });

  it('someone without a second factor is sent to set it up (CONFIGURE_TOTP)', async () => {
    const result = await loginWithAuthorizationCode('carlos.dev', password, { acr: 'mfa' });
    expect(result.tokens).toBeUndefined();
    expect(result.redirect?.searchParams.get('execution')).toBe('CONFIGURE_TOTP');
  });

  it('setting up a second factor e-mails the account owner and is kept as an event', async () => {
    // A first-use enrollment is trust on first use: the owner must hear about it (M3-08).
    const login = await fetch(`${keycloakUrl()}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: env('KEYCLOAK_ADMIN_USER'),
        password: env('KEYCLOAK_ADMIN_PASSWORD'),
      }),
    });
    const { access_token: adminToken } = (await login.json()) as { access_token: string };
    const admin = (method: string, path: string, body?: unknown) =>
      fetch(`${keycloakUrl()}/admin/realms/den-portal${path}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const username = `mfa-probe-${randomUUID().slice(0, 8)}`;
    const email = `${username}@demo.den.example`;
    const created = await admin('POST', '/users', {
      username,
      email,
      emailVerified: true,
      enabled: true,
      firstName: 'Prueba',
      lastName: 'Segundo factor',
      credentials: [{ type: 'password', value: password, temporary: false }],
    });
    expect(created.status).toBe(201);
    const userId = created.headers.get('location')?.split('/').at(-1) ?? '';
    try {
      const jar = new CookieJar();
      const asked = await loginWithAuthorizationCode(username, password, { jar, acr: 'mfa' });
      expect(asked.redirect?.searchParams.get('execution')).toBe('CONFIGURE_TOTP');
      const page = await fetch(asked.redirect ?? '', { headers: { cookie: jar.header() } });
      jar.store(page);
      const html = await page.text();
      const action = /<form[^>]+action="([^"]+)"[^>]+id="kc-totp-settings-form"/.exec(html)?.[1];
      const secret = /name="totpSecret"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? '';
      expect(action).toBeDefined();
      const enrolled = await fetch((action ?? '').replaceAll('&amp;', '&'), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
        body: new URLSearchParams({ totp: totp(secret), totpSecret: secret, userLabel: 'prueba' }),
      });
      expect(new URL(enrolled.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();

      const mailpit = `http://localhost:${env('MAILPIT_UI_PORT', '8025')}/api/v1`;
      let subjects: string[] = [];
      for (let i = 0; i < 20 && subjects.length === 0; i += 1) {
        const found = (await (
          await fetch(`${mailpit}/search?query=${encodeURIComponent(`to:${email}`)}`)
        ).json()) as { messages: Array<{ Subject: string }> };
        subjects = found.messages.map((m) => m.Subject);
        if (subjects.length === 0) await new Promise((r) => setTimeout(r, 500));
      }
      // One notice, for the credential event only (not one per event type, nor login errors).
      expect(subjects).toHaveLength(1);
      const events = (await (await admin('GET', `/events?user=${userId}`)).json()) as Array<{
        type: string;
      }>;
      expect(events.map((e) => e.type)).toContain('UPDATE_CREDENTIAL');
    } finally {
      await admin('DELETE', `/users/${userId}`);
    }
  });
});

describe('realm den-gateway (M0-03)', () => {
  const admin = `${keycloakUrl()}/admin/realms`;
  let provisionerToken: string;
  const appClientId = `den-app-${randomUUID()}`;
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
      'den-gateway',
      env('DEN_GATEWAY_PROVISIONER_CLIENT_ID', 'den-portal-provisioner'),
      env('DEN_GATEWAY_PROVISIONER_SECRET'),
    );
    expect(res.status).toBe(200);
    provisionerToken = ((await res.json()) as { access_token: string }).access_token;
  });

  afterAll(async () => {
    if (appInternalId)
      await asProvisioner(`/den-gateway/clients/${appInternalId}`, { method: 'DELETE' });
  });

  it('lets the portal provisioner create an application client', async () => {
    const res = await asProvisioner('/den-gateway/clients', {
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

  it('issues minimal 5-minute application tokens with the den-gateway audience', async () => {
    const secretRes = await asProvisioner(`/den-gateway/clients/${appInternalId}/client-secret`);
    const { value: secret } = (await secretRes.json()) as { value: string };

    const tokenRes = await clientCredentialsToken('den-gateway', appClientId, secret);
    expect(tokenRes.status).toBe(200);
    const claims = decodeJwt(((await tokenRes.json()) as { access_token: string }).access_token);

    expect(claims.iss).toBe(`${keycloakUrl()}/realms/den-gateway`);
    expect(audiences(claims)).toEqual(['den-gateway']);
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

  it('rotates a portal-managed secret: the previous one works until removed (M3-04)', async () => {
    const clientId = `den-app-rotation-${Date.now()}`;
    const base = {
      clientId,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      clientAuthenticatorType: 'client-secret',
      attributes: { 'den.managed': 'true' },
    };
    const created = await asProvisioner('/den-gateway/clients', {
      method: 'POST',
      body: JSON.stringify({ ...base, secret: 'previous-secret-0123456789abcdef' }),
    });
    expect(created.status).toBe(201);
    const id = created.headers.get('location')?.split('/').pop() ?? '';
    const works = async (secret: string) =>
      (await clientCredentialsToken('den-gateway', clientId, secret)).status === 200;
    try {
      // What the portal reconciler does: regenerate (previous -> rotated), then set the new one.
      expect(
        (await asProvisioner(`/den-gateway/clients/${id}/client-secret`, { method: 'POST' }))
          .status,
      ).toBe(200);
      const put = await asProvisioner(`/den-gateway/clients/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...base, secret: 'new-secret-0123456789abcdef0123' }),
      });
      expect(put.status).toBe(204);
      expect(await works('new-secret-0123456789abcdef0123')).toBe(true);
      expect(await works('previous-secret-0123456789abcdef')).toBe(true);

      const rotated = await asProvisioner(`/den-gateway/clients/${id}/client-secret/rotated`);
      expect(((await rotated.json()) as { value: string }).value).toBe(
        'previous-secret-0123456789abcdef',
      );
      // Revocation, or the end of the window.
      expect(
        (
          await asProvisioner(`/den-gateway/clients/${id}/client-secret/rotated`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(204);
      expect(await works('previous-secret-0123456789abcdef')).toBe(false);
      expect(await works('new-secret-0123456789abcdef0123')).toBe(true);
    } finally {
      await asProvisioner(`/den-gateway/clients/${id}`, { method: 'DELETE' });
    }
  });

  it('confines the provisioner to clients of den-gateway', async () => {
    expect((await asProvisioner('/den-gateway/users')).status).toBe(403);
    expect((await asProvisioner('/den-gateway/roles')).status).toBe(403);
    expect((await asProvisioner('/den-portal/clients')).status).toBe(403);
    expect((await asProvisioner('/master/clients')).status).toBe(403);
  });
});

const citizens = (
  JSON.parse(readFileSync(fromRoot('infra/keycloak/den-citizens-realm.json'), 'utf8')) as {
    users: Array<{ id: string; username: string; attributes: Record<string, string[]> }>;
  }
).users;

describe('realm den-citizens (MT-05)', () => {
  const password = env('DEN_DEMO_USER_PASSWORD', 'den-demo-password');

  it.each(citizens)(
    '$username logs in to the citizen app and its token carries the verified document only',
    async (citizen) => {
      const result = await loginWithAuthorizationCode(citizen.username, password, {
        client: citizenAppClient(),
      });
      expect(result.tokens, result.page?.slice(0, 200)).toBeDefined();
      const claims = decodeJwt(result.tokens?.access_token ?? '');
      expect(claims.iss).toBe(`${keycloakUrl()}/realms/den-citizens`);
      expect(claims.sub).toBe(citizen.id);
      expect(claims.azp).toBe('citizen-app');
      expect(audiences(claims)).toEqual(['den-transparency-api']);
      expect(claims.document_type).toBe(citizen.attributes.document_type?.[0]);
      expect(claims.document_number).toBe(citizen.attributes.document_number?.[0]);
      // Nothing else about the person travels to the portal.
      for (const claim of ['email', 'name', 'given_name', 'family_name', 'realm_access']) {
        expect(claims).not.toHaveProperty(claim);
      }
    },
  );

  it('does not allow the password grant on the citizen app client', async () => {
    const client = citizenAppClient();
    const res = await fetch(`${keycloakUrl()}/realms/den-citizens/protocol/openid-connect/token`, {
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

  it('refuses redirect URIs outside the citizen app', async () => {
    const result = await loginWithAuthorizationCode('ciudadana.demo', password, {
      client: citizenAppClient(),
      redirectUri: 'https://attacker.example/callback',
    });
    expect(result.tokens).toBeUndefined();
  });
});
