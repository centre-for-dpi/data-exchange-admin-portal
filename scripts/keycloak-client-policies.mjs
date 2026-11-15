#!/usr/bin/env node
// Applies the client profiles and policies of infra/keycloak/rid-gateway-realm.json (secret
// rotation, M3-04) to a Keycloak that imported the realm before they existed: --import-realm
// skips realms that already exist. Idempotent: it replaces both lists with the file's.
//
//   node scripts/keycloak-client-policies.mjs
//
// Uses KEYCLOAK_URL, KEYCLOAK_ADMIN_USER and KEYCLOAK_ADMIN_PASSWORD from the environment or the
// repo-root .env (master realm administrator).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const url = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const realmFile = JSON.parse(
  readFileSync(resolve(root, 'infra/keycloak/rid-gateway-realm.json'), 'utf8'),
);

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

for (const [path, body] of [
  ['client-policies/profiles', realmFile.clientProfiles],
  ['client-policies/policies', realmFile.clientPolicies],
]) {
  const res = await fetch(`${url}/admin/realms/${realmFile.realm}/${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`PUT ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`${realmFile.realm}: ${path} applied`);
}
