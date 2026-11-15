#!/usr/bin/env node
// Applies the second-factor setup of infra/keycloak/rid-portal-realm.json (M3-08, ADR-0021) to a
// Keycloak that imported the realm before it existed: --import-realm skips existing realms.
//
//   node scripts/keycloak-portal-mfa.mjs              # realm settings and the login flow
//   node scripts/keycloak-portal-mfa.mjs --demo-otp   # also the demo users' TOTP (dev and demo only)
//
// Idempotent. It sets the ACR to level-of-authentication map and the OTP policy, rebuilds the
// browser flow `rid-browser` from the file and binds it. With --demo-otp, each seed user that has
// an OTP credential in the file and none in Keycloak is re-imported from the file (same id, the
// password of RID_DEMO_USER_PASSWORD and the code of RID_DEMO_TOTP_SECRET): Keycloak's admin API
// cannot add an OTP credential to an existing user.
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
const raw = readFileSync(resolve(root, 'infra/keycloak/rid-portal-realm.json'), 'utf8');
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
  // Unbound while the flow is rebuilt: a bound flow cannot be deleted.
  ...(current.browserFlow === flowAlias ? { browserFlow: 'browser' } : {}),
});
console.log(`${realm}: acr.loa.map and OTP policy applied`);

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
    const credentials = await admin('GET', `/users/${user.id}/credentials`);
    if (!credentials) {
      console.log(`${realm}: ${user.username} does not exist, skipped`);
      continue;
    }
    if (credentials.some((c) => c.type === 'otp')) continue;
    await admin('POST', '/partialImport', { ifResourceExists: 'OVERWRITE', users: [user] });
    console.log(`${realm}: ${user.username} re-imported with the demo one-time code`);
  }
}
