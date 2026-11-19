#!/usr/bin/env node
// Brings the client of the reference citizen app (MT-07) in realm den-citizens in line with
// infra/keycloak/den-citizens-realm.json on a Keycloak that imported the realm before: since the
// rename of commit 9de1423 the client is `citizen-app`, and an installation from before still has
// `carpeta-ciudadana` (--import-realm skips realms that exist). `install.sh update` runs it
// (`install.sh realms`), before keycloak-portal-mfa.mjs.
//
//   node scripts/keycloak-citizen-app.mjs
//
// Idempotent. It creates the client scopes of the file that are missing, creates `citizen-app`
// from the file when it does not exist, then sets on it the file's settings: the secret
// (DEN_CITIZEN_APP_CLIENT_SECRET), the root URL, redirect URIs and web origins
// (DEN_CITIZEN_APP_URL), PKCE and the default client scopes. Last, it deletes the client of
// before the rename: tokens are issued to `citizen-app` only. A Keycloak without the realm (the
// country's own identity provider in production) is left alone.
//
// Uses KEYCLOAK_URL, KEYCLOAK_ADMIN_USER and KEYCLOAK_ADMIN_PASSWORD from the environment or the
// repo-root .env (master realm administrator).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const REALM = 'den-citizens';
const CLIENT_ID = 'citizen-app';
/** Client ids the reference citizen app had before (commit 9de1423). */
const LEGACY_CLIENT_IDS = ['carpeta-ciudadana'];

const url = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
// Keycloak's own placeholder syntax, ${NAME} or ${NAME:default}, resolved like --import-realm does.
const raw = readFileSync(resolve(root, 'infra/keycloak/den-citizens-realm.json'), 'utf8');
const realmFile = JSON.parse(
  raw.replace(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g, (_, name, fallback) => {
    const value = process.env[name] || fallback;
    if (value === undefined) throw new Error(`${name} is not set`);
    return JSON.stringify(value).slice(1, -1);
  }),
);
const wanted = realmFile.clients.find((c) => c.clientId === CLIENT_ID);
if (!wanted) throw new Error(`${CLIENT_ID} is not in den-citizens-realm.json`);

const login = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: process.env.KEYCLOAK_ADMIN_USER ?? '',
    password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? '',
  }),
});
if (!login.ok) {
  console.error(`Keycloak admin login failed (${login.status})`);
  process.exit(1);
}
const { access_token: token } = await login.json();

async function admin(method, path, body) {
  const res = await fetch(`${url}/admin/realms/${REALM}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(
      `${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    );
  }
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}
const findClient = async (clientId) =>
  (await admin('GET', `/clients?clientId=${encodeURIComponent(clientId)}`))?.[0];

if (!(await admin('GET', ''))) {
  console.log(`${REALM}: realm not found, skipped`);
  process.exit(0);
}

// 1. The client scopes the client uses by default (document claims, the API's audience).
const scopes = await admin('GET', '/client-scopes');
for (const scope of realmFile.clientScopes ?? []) {
  if (scopes.some((s) => s.name === scope.name)) continue;
  await admin('POST', '/client-scopes', scope);
  console.log(`${REALM}: client scope ${scope.name} created`);
}

// 2. The client: created from the file when missing (the import path keeps its default scopes).
if (!(await findClient(CLIENT_ID))) {
  await admin('POST', '/partialImport', { ifResourceExists: 'SKIP', clients: [wanted] });
  console.log(`${REALM}: client ${CLIENT_ID} created from the realm file`);
}
const client = await findClient(CLIENT_ID);
await admin('PUT', `/clients/${client.id}`, {
  ...client,
  name: wanted.name,
  enabled: wanted.enabled,
  publicClient: wanted.publicClient,
  clientAuthenticatorType: wanted.clientAuthenticatorType,
  secret: wanted.secret,
  standardFlowEnabled: wanted.standardFlowEnabled,
  implicitFlowEnabled: wanted.implicitFlowEnabled,
  directAccessGrantsEnabled: wanted.directAccessGrantsEnabled,
  serviceAccountsEnabled: wanted.serviceAccountsEnabled,
  frontchannelLogout: wanted.frontchannelLogout,
  fullScopeAllowed: wanted.fullScopeAllowed,
  rootUrl: wanted.rootUrl,
  redirectUris: wanted.redirectUris,
  webOrigins: wanted.webOrigins,
  attributes: { ...client.attributes, ...wanted.attributes },
});
const allScopes = await admin('GET', '/client-scopes');
const defaults = await admin('GET', `/clients/${client.id}/default-client-scopes`);
for (const name of wanted.defaultClientScopes ?? []) {
  if (defaults.some((s) => s.name === name)) continue;
  const scope = allScopes.find((s) => s.name === name);
  await admin('PUT', `/clients/${client.id}/default-client-scopes/${scope.id}`);
  console.log(`${REALM}: default client scope ${name} added to ${CLIENT_ID}`);
}
console.log(
  `${REALM}: ${CLIENT_ID} aligned with the realm file (secret, ${wanted.redirectUris.join(', ')})`,
);

// 3. The client of before the rename: deleted, so that no token is issued to it any more.
for (const clientId of LEGACY_CLIENT_IDS) {
  const legacy = await findClient(clientId);
  if (!legacy) continue;
  await admin('DELETE', `/clients/${legacy.id}`);
  console.log(`${REALM}: client ${clientId} of before the rename deleted`);
}
