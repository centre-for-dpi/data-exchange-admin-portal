#!/usr/bin/env node
// Writes the .env of a single-host deployment (infra/compose/docker-compose.deploy.yml) from
// .env.example: fresh random secrets, a new transparency signing key, the internal service names
// of the Compose network and the public URL. Prints nothing secret.
//
//   node scripts/make-deploy-env.mjs https://portal.example.org [--out .env] [--demo-password <pw>]
//     [--gateway-host <name>] [--traefik-network <net>] [--country <code>]
//
// install.sh (docs/INSTALL.md) runs it with the answers of the operator.
//
// The seed users' password is random unless --demo-password is given, or RID_DEPLOY_DEMO_PASSWORD
// (install.sh uses the variable: a password on the command line shows in the process list).
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
    // The gateway's own name (M3-10): its TLS ends in APISIX, behind a TLS passthrough.
    'gateway-host': { type: 'string' },
    // config/country/<code>.yaml; .env.example's value when absent.
    country: { type: 'string' },
  },
});
const [publicUrl] = positionals;
if (!publicUrl || !/^https:\/\/[a-z0-9.-]+$/i.test(publicUrl)) {
  console.error(
    'Usage: make-deploy-env.mjs https://<host> --gateway-host <gateway name> [--out .env] [--demo-password <pw>]',
  );
  process.exit(2);
}
const gatewayHost = values['gateway-host'];
if (gatewayHost !== undefined && !/^[a-z0-9.-]+$/i.test(gatewayHost)) {
  console.error('--gateway-host is a host name, such as gw.example.org');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const country = values.country;
if (
  country !== undefined &&
  (!/^[a-z]{2,3}$/.test(country) || !existsSync(resolve(root, 'config/country', `${country}.yaml`)))
) {
  console.error(`--country: no config/country/${country}.yaml`);
  process.exit(2);
}
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
// WireGuard hub of the kit nodes (M4-03): an X25519 key pair, raw 32 bytes in base64 like `wg`.
const hub = generateKeyPairSync('x25519');
const raw = (jwkField) => Buffer.from(jwkField ?? '', 'base64url').toString('base64');
const webhookSecret = `whsec_${randomBytes(32).toString('base64')}`;
const set = {
  ...(country ? { RID_COUNTRY: country } : {}),
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
  // Kit nodes (M4): the control route's token, and the hub's keys. Nodes reach the hub on the
  // gateway's name (or the portal's), UDP 51820, published by docker-compose.deploy.yml.
  RID_NODE_CONTROL_TOKEN: secret(32),
  RID_GATEWAY_PORTAL_API_URL: 'http://api:4000',
  RID_WG_HUB_PRIVATE_KEY: raw(hub.privateKey.export({ format: 'jwk' }).d),
  RID_WG_HUB_PUBLIC_KEY: raw(hub.publicKey.export({ format: 'jwk' }).x),
  RID_WG_HUB_ENDPOINT: `${gatewayHost ?? new URL(publicUrl).hostname}:51820`,
  RID_WG_HUB_AGENT_URL: 'http://wg-hub:8090',
  // Validations at submission (M4-06).
  RID_VALIDATION_TOKEN: secret(32),
  RID_GATEWAY_INTERNAL_URL: 'http://apisix:9080',
  // Access-log analytics (M5): the API reads OpenSearch and keeps its index template.
  RID_OPENSEARCH_URL: 'http://opensearch:9200',
  // Metrics and alerts (M5-06): Prometheus scrapes the API's /metrics with this token; the
  // indicators read the gateway's availability from Prometheus; Grafana at /grafana.
  RID_METRICS_TOKEN: secret(32),
  // APISIX's data_encryption key for the private keys in etcd: 16 characters (M6-01).
  RID_APISIX_KEYRING: secret(12),
  // The proxy's address or network (M6-01): only it may set X-Forwarded-For, the caller's address
  // for rate limits and security events. Pass it when generating (RID_TRUST_PROXY=172.30.0.2
  // node scripts/make-deploy-env.mjs ...); empty, the API trusts nobody (DEPLOYMENT.md).
  RID_TRUST_PROXY: process.env.RID_TRUST_PROXY ?? '',
  RID_PROMETHEUS_URL: 'http://prometheus:9090',
  GRAFANA_ADMIN_PASSWORD: secret(16),
  GRAFANA_ROOT_URL: `${publicUrl.replace(/\/$/, '')}/grafana/`,
  GRAFANA_SERVE_FROM_SUB_PATH: 'true',
  RID_CONTRACT_RUNNER_URL: 'http://contract-runner:8096',
  RID_CONTRACT_RUNNER_TOKEN: secret(32),
  RID_CONTRACT_RUNNER_GATEWAY_URL: 'http://apisix:9080',
  RID_WG_HUB_AGENT_TOKEN: secret(32),
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
  // With mTLS (features.mtls.required) applications reach the gateway on its own name, whose TLS
  // APISIX terminates; /gw on the portal's name only works without mTLS (DEPLOYMENT.md §5.2).
  RID_GATEWAY_PUBLIC_URL: gatewayHost ? `https://${gatewayHost}` : `${publicUrl}/gw`,
  ...(gatewayHost ? { RID_GATEWAY_TLS_HOSTS: gatewayHost } : {}),
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
  RID_DEMO_USER_PASSWORD:
    values['demo-password'] || process.env.RID_DEPLOY_DEMO_PASSWORD || secret(12),
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
