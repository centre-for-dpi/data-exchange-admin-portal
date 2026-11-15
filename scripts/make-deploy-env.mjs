#!/usr/bin/env node
// Writes the .env of a single-host deployment (infra/compose/docker-compose.deploy.yml) from
// .env.example: fresh random secrets, a new transparency signing key, the internal service names
// of the Compose network and the public URL. Prints nothing secret.
//
//   node scripts/make-deploy-env.mjs https://portal.example.org [--out .env] [--demo-password <pw>]
//
// The seed users' password is random unless --demo-password is given.
//
// Refuses to overwrite an existing file: secrets of a running deployment (database passwords,
// the signing key, the subject key) must not change under it.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: '.env' },
    'demo-password': { type: 'string' },
    'traefik-network': { type: 'string', default: 'lab-router_default' },
  },
});
const [publicUrl] = positionals;
if (!publicUrl || !/^https:\/\/[a-z0-9.-]+$/i.test(publicUrl)) {
  console.error('Usage: make-deploy-env.mjs https://<host> [--out .env] [--demo-password <pw>]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, values.out);
if (existsSync(out)) {
  console.error(`${out} exists: not overwriting the secrets of a deployment.`);
  process.exit(1);
}

const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');
const stepCaPassword = secret();
const { privateKey } = generateKeyPairSync('ed25519');
const signingJwk = {
  ...privateKey.export({ format: 'jwk' }),
  kid: `rid-${new Date().toISOString().slice(0, 7)}`,
  alg: 'EdDSA',
  use: 'sig',
};

const db = { owner: secret(), app: secret(), keycloak: secret() };
const webhookSecret = `whsec_${randomBytes(32).toString('base64')}`;
const set = {
  POSTGRES_PASSWORD: db.owner,
  RID_APP_DB_PASSWORD: db.app,
  DATABASE_URL: `postgresql://rid_app:${db.app}@postgres:5432/rid`,
  DATABASE_MIGRATION_URL: `postgresql://rid:${db.owner}@postgres:5432/rid`,
  TEST_DATABASE_URL: `postgresql://rid_app:${db.app}@postgres:5432/rid_test`,
  TEST_DATABASE_MIGRATION_URL: `postgresql://rid:${db.owner}@postgres:5432/rid_test`,
  KEYCLOAK_DB_PASSWORD: db.keycloak,
  KEYCLOAK_ADMIN_PASSWORD: secret(),
  RID_PORTAL_WEB_CLIENT_SECRET: secret(),
  RID_GATEWAY_PROVISIONER_SECRET: secret(),
  RID_CARPETA_CLIENT_SECRET: secret(),
  APISIX_ADMIN_KEY: secret(),
  OPA_BUNDLE_TOKEN: secret(),
  RID_END_USER_HASH_SALT: secret(32),
  RID_SUBJECT_REF_KEY: secret(32),
  RID_TRANSPARENCY_INGEST_TOKEN: secret(),
  // The dev-style CA initialises its provisioner with this same password (infra/step-ca).
  STEP_CA_PASSWORD: stepCaPassword,
  RID_STEP_CA_PROVISIONER_PASSWORD: stepCaPassword,
  AUTH_SECRET: randomBytes(32).toString('base64'),
  RID_SECRETS_KEY: randomBytes(32).toString('base64'),
  RID_TRANSPARENCY_SIGNING_JWK: `'${JSON.stringify(signingJwk)}'`,
  RID_TRANSPARENCY_LOG_ID: 'rid-transparency',
  // Public URLs (one host; the reverse proxy routes by path).
  RID_PUBLIC_URL: publicUrl,
  RID_WEB_URL: publicUrl,
  AUTH_URL: publicUrl,
  KEYCLOAK_URL: `${publicUrl}/auth`,
  RID_GATEWAY_PUBLIC_URL: `${publicUrl}/gw`,
  RID_CITIZEN_ISSUER: `${publicUrl}/auth/realms/rid-citizens`,
  RID_CARPETA_URL: `${publicUrl}/carpeta`,
  // Internal service names on the Compose network.
  RID_API_URL: 'http://api:4000',
  APISIX_ADMIN_URL: 'http://apisix:9180',
  RID_GATEWAY_KEYCLOAK_URL: 'http://keycloak:8080/auth',
  OPA_PORTAL_URL: 'http://api:4000/api/v1/opa',
  RID_TRANSPARENCY_COLLECTOR_HOST: 'api',
  RID_TSA_URL: 'http://tsa:3004',
  RID_STEP_CA_URL: 'https://step-ca:9000',
  // The step-ca volume is mounted read-only in the API container (docker-compose.deploy.yml).
  RID_STEP_CA_ROOT_FILE: '/var/lib/rid/step-ca/root_ca.crt',
  TRAEFIK_NETWORK: values['traefik-network'],
  // Random unless asked: the seed users include platform administrators.
  RID_DEMO_USER_PASSWORD: values['demo-password'] ?? secret(12),
  // Their one-time code key (M3-08): with the default, anyone could read it in the repo.
  RID_DEMO_TOTP_SECRET: secret(20),
  MAILPIT_UI_AUTH: `mail:${secret(12)}`,
  // Notices (MT-06) to the reference citizen folder (MT-07), over the Compose network.
  RID_CITIZEN_APPS: `'${JSON.stringify({
    'carpeta-ciudadana': {
      webhookUrl: 'http://carpeta:3100/carpeta/api/rid/alerts',
      webhookSecret: webhookSecret,
    },
  })}'`,
  CITIZEN_APP_WEBHOOK_SECRET: webhookSecret,
};

const lines = readFileSync(resolve(root, '.env.example'), 'utf8').split('\n');
const seen = new Set();
const result = lines.map((line) => {
  const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
  if (!key || !(key in set)) return line;
  seen.add(key);
  return `${key}=${set[key]}`;
});
const extra = Object.keys(set).filter((k) => !seen.has(k));
if (extra.length > 0) {
  result.push(
    '',
    '# Deployment (scripts/make-deploy-env.mjs)',
    ...extra.map((k) => `${k}=${set[k]}`),
  );
}
writeFileSync(out, `${result.join('\n').trimEnd()}\n`, { mode: 0o600 });
console.log(`Wrote ${out} for ${publicUrl} (kid ${signingJwk.kid}).`);
console.log(
  'Demo users password: RID_DEMO_USER_PASSWORD; one-time codes: pnpm demo:otp (RID_DEMO_TOTP_SECRET); ' +
    'Mailpit login: MAILPIT_UI_AUTH (in that file).',
);
