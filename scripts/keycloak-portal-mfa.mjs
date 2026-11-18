#!/usr/bin/env node
// Applies the second-factor setup of infra/keycloak/den-portal-realm.json (M3-08, ADR-0021), the
// hardening of M6-01 (password policy, events, exact redirect URIs of the portal and the
// citizens' folder) and the lifespan of the verification link (P-08) to a Keycloak that imported
// the realms before: --import-realm skips them. `install.sh update` runs it (`install.sh realms`).
//
//   node scripts/keycloak-portal-mfa.mjs              # realm settings and the login flow
//   node scripts/keycloak-portal-mfa.mjs --demo-otp   # also the demo users' TOTP (dev and demo only)
//
// Idempotent. It sets the ACR to level-of-authentication map and the OTP policy, rebuilds the
// browser flow `den-browser` from the file and binds it. With --demo-otp, each seed user that has
// an OTP credential in the file and none in Keycloak is re-imported from the file (same id, the
// password of DEN_DEMO_USER_PASSWORD and the code of DEN_DEMO_TOTP_SECRET): Keycloak's admin API
// cannot add an OTP credential to an existing user. A disabled one is left alone.
//
// Uses KEYCLOAK_URL, KEYCLOAK_ADMIN_USER and KEYCLOAK_ADMIN_PASSWORD from the environment or the
// repo-root .env (master realm administrator).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const url = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const demoOtp = process.argv.includes('--demo-otp');
// Keycloak's own placeholder syntax, ${NAME} or ${NAME:default}, resolved like --import-realm does.
const raw = readFileSync(resolve(root, 'infra/keycloak/den-portal-realm.json'), 'utf8');
const realmFile = JSON.parse(
  raw.replace(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g, (_, name, fallback) => {
    const value = process.env[name] ?? fallback;
    if (value === undefined) throw new Error(`${name} is not set`);
    return JSON.stringify(value).slice(1, -1);
  }),
);
const realm = realmFile.realm;

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
  const res = await fetch(`${url}/admin/realms/${realm}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    );
  }
  if (res.status === 404) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

// 1. Realm settings: ACR -> level of authentication, and the OTP policy.
const current = await admin('GET', '');
const flowAlias = realmFile.browserFlow;
await admin('PUT', '', {
  attributes: { ...current.attributes, ...realmFile.attributes },
  otpPolicyType: realmFile.otpPolicyType,
  otpPolicyAlgorithm: realmFile.otpPolicyAlgorithm,
  otpPolicyDigits: realmFile.otpPolicyDigits,
  otpPolicyPeriod: realmFile.otpPolicyPeriod,
  otpPolicyLookAheadWindow: realmFile.otpPolicyLookAheadWindow,
  // Credential changes are kept 90 days and e-mailed to the account owner.
  eventsEnabled: realmFile.eventsEnabled,
  eventsExpiration: realmFile.eventsExpiration,
  enabledEventTypes: realmFile.enabledEventTypes,
  eventsListeners: realmFile.eventsListeners,
  // M6-01: the password policy and the administrators' events.
  passwordPolicy: realmFile.passwordPolicy,
  adminEventsEnabled: realmFile.adminEventsEnabled,
  adminEventsDetailsEnabled: realmFile.adminEventsDetailsEnabled,
  // P-08: how long the e-mail verification and password reset links last (Keycloak: 5 minutes).
  actionTokenGeneratedByUserLifespan: realmFile.actionTokenGeneratedByUserLifespan,
  // Unbound while the flow is rebuilt: a bound flow cannot be deleted.
  ...(current.browserFlow === flowAlias ? { browserFlow: 'browser' } : {}),
});
console.log(
  `${realm}: acr.loa.map, OTP and password policies, the events and the ` +
    `${realmFile.actionTokenGeneratedByUserLifespan / 60}-minute verification link applied`,
);

// 1b. The exact redirect URIs of the clients (M6-01), from this file and the citizens' realm.
const resolveFile = (file) =>
  JSON.parse(
    readFileSync(resolve(root, 'infra/keycloak', file), 'utf8').replace(
      /\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g,
      (_, name, fallback) => JSON.stringify(process.env[name] ?? fallback ?? '').slice(1, -1),
    ),
  );
for (const [realmName, file, clientId] of [
  [realm, 'den-portal-realm.json', 'den-portal-web'],
  ['den-citizens', 'den-citizens-realm.json', 'citizen-app'],
]) {
  const wanted = resolveFile(file).clients.find((c) => c.clientId === clientId);
  if (!wanted) continue;
  const res = await fetch(
    `${url}/admin/realms/${realmName}/clients?clientId=${encodeURIComponent(clientId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const [client] = res.ok ? await res.json() : [];
  if (!client) {
    console.log(`${realmName}: client ${clientId} not found, skipped`);
    continue;
  }
  const put = await fetch(`${url}/admin/realms/${realmName}/clients/${client.id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ...client,
      redirectUris: wanted.redirectUris,
      attributes: {
        ...client.attributes,
        'post.logout.redirect.uris': wanted.attributes['post.logout.redirect.uris'],
      },
    }),
  });
  if (!put.ok) throw new Error(`${realmName}/${clientId}: ${put.status} ${await put.text()}`);
  console.log(`${realmName}: ${clientId} redirect URIs set to ${wanted.redirectUris.join(', ')}`);
}

// 2. The browser flow, rebuilt from the file (deleting a flow deletes its sub-flows and configs).
const flows = realmFile.authenticationFlows;
const configs = new Map(realmFile.authenticatorConfig.map((c) => [c.alias, c]));
const existing = (await admin('GET', '/authentication/flows')).find((f) => f.alias === flowAlias);
if (existing) await admin('DELETE', `/authentication/flows/${existing.id}`);
const top = flows.find((f) => f.alias === flowAlias);
await admin('POST', '/authentication/flows', {
  alias: top.alias,
  description: top.description,
  providerId: top.providerId,
  topLevel: true,
  builtIn: false,
});

async function addExecutions(flow) {
  const path = `/authentication/flows/${encodeURIComponent(flow.alias)}/executions`;
  const ordered = [...flow.authenticationExecutions].sort((a, b) => a.priority - b.priority);
  for (const execution of ordered) {
    if (execution.authenticatorFlow) {
      const sub = flows.find((f) => f.alias === execution.flowAlias);
      await admin('POST', `${path}/flow`, {
        alias: sub.alias,
        description: sub.description,
        type: sub.providerId,
        provider: 'registration-page-form',
      });
    } else {
      await admin('POST', `${path}/execution`, { provider: execution.authenticator });
    }
    // The execution just added is the last one at this level of the flow.
    const added = (await admin('GET', path)).filter((e) => e.level === 0).at(-1);
    await admin('PUT', path, { ...added, requirement: execution.requirement });
    if (execution.authenticatorConfig) {
      const config = configs.get(execution.authenticatorConfig);
      await admin('POST', `/authentication/executions/${added.id}/config`, {
        alias: config.alias,
        config: config.config,
      });
    }
    if (execution.authenticatorFlow)
      await addExecutions(flows.find((f) => f.alias === execution.flowAlias));
  }
}
await addExecutions(top);
await admin('PUT', '', { browserFlow: flowAlias });
console.log(`${realm}: browser flow ${flowAlias} rebuilt and bound`);

// 3. Demo users' one-time codes (never in production: the seed users do not exist there).
if (demoOtp) {
  for (const user of realmFile.users.filter((u) => u.credentials?.some((c) => c.type === 'otp'))) {
    const existing = await admin('GET', `/users/${user.id}`);
    if (!existing) {
      console.log(`${realm}: ${user.username} does not exist, skipped`);
      continue;
    }
    // Disabled by the operator (install.sh demo-users disable, P-08): re-importing would enable it.
    if (existing.enabled === false) {
      console.log(`${realm}: ${user.username} is disabled, skipped`);
      continue;
    }
    const credentials = await admin('GET', `/users/${user.id}/credentials`);
    if (credentials.some((c) => c.type === 'otp')) continue;
    await admin('POST', '/partialImport', { ifResourceExists: 'OVERWRITE', users: [user] });
    console.log(`${realm}: ${user.username} re-imported with the demo one-time code`);
  }
}
