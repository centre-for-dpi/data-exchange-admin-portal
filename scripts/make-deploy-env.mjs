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
// The seed users' password is random unless --demo-password is given, or DEN_DEPLOY_DEMO_PASSWORD
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
    // The reverse proxy's Docker network; den-edge is the one install.sh makes for its own.
    'traefik-network': { type: 'string', default: 'den-edge' },
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
// The realm's password policy (M6-01) refuses shorter ones, and Keycloak would not import it.
// An empty value (install.sh's "Enter = random") counts as absent. It is written in single quotes
// (B-30: $ and # stay literal for Compose, bash and Node) and goes into the realm's JSON on
// import: no quotes, backslashes or line breaks.
const demoPassword = values['demo-password'] || process.env.DEN_DEPLOY_DEMO_PASSWORD || undefined;
if (demoPassword !== undefined && demoPassword.length < 12) {
  console.error('--demo-password: at least 12 characters (the realm password policy)');
  process.exit(1);
}
if (demoPassword !== undefined && /['"\\\r\n]/.test(demoPassword)) {
  console.error('--demo-password: no quotes, backslashes or line breaks');
  process.exit(1);
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
  kid: `den-${new Date().toISOString().slice(0, 7)}`,
  alg: 'EdDSA',
  use: 'sig',
};

const db = { owner: secret(), app: secret(), keycloak: secret() };
// WireGuard hub of the kit nodes (M4-03): an X25519 key pair, raw 32 bytes in base64 like `wg`.
const hub = generateKeyPairSync('x25519');
const raw = (jwkField) => Buffer.from(jwkField ?? '', 'base64url').toString('base64');
const webhookSecret = `whsec_${randomBytes(32).toString('base64')}`;
const set = {
  ...(country ? { DEN_COUNTRY: country } : {}),
  POSTGRES_PASSWORD: db.owner,
  DEN_APP_DB_PASSWORD: db.app,
  DATABASE_URL: `postgresql://den_app:${db.app}@postgres:5432/den`,
  DATABASE_MIGRATION_URL: `postgresql://den:${db.owner}@postgres:5432/den`,
  TEST_DATABASE_URL: `postgresql://den_app:${db.app}@postgres:5432/den_test`,
  TEST_DATABASE_MIGRATION_URL: `postgresql://den:${db.owner}@postgres:5432/den_test`,
  KEYCLOAK_DB_PASSWORD: db.keycloak,
  KEYCLOAK_ADMIN_PASSWORD: secret(),
  DEN_PORTAL_WEB_CLIENT_SECRET: secret(),
  DEN_GATEWAY_PROVISIONER_SECRET: secret(),
  DEN_CITIZEN_APP_CLIENT_SECRET: secret(),
  APISIX_ADMIN_KEY: secret(),
  OPA_BUNDLE_TOKEN: secret(),
  // OPA's API and etcd require credentials on the gateway's network (B-15, ADR-0031).
  DEN_OPA_DECISION_TOKEN: secret(32),
  DEN_OPA_ADMIN_TOKEN: secret(32),
  ETCD_ROOT_PASSWORD: secret(),
  APISIX_ETCD_PASSWORD: secret(),
  DEN_END_USER_HASH_SALT: secret(32),
  DEN_SUBJECT_REF_KEY: secret(32),
  DEN_TRANSPARENCY_INGEST_TOKEN: secret(),
  // Kit nodes (M4): the control route's token, and the hub's keys. Nodes reach the hub on the
  // gateway's name (or the portal's), UDP 51820, published by docker-compose.deploy.yml.
  DEN_NODE_CONTROL_TOKEN: secret(32),
  DEN_GATEWAY_PORTAL_API_URL: 'http://api:4000',
  DEN_WG_HUB_PRIVATE_KEY: raw(hub.privateKey.export({ format: 'jwk' }).d),
  DEN_WG_HUB_PUBLIC_KEY: raw(hub.publicKey.export({ format: 'jwk' }).x),
  DEN_WG_HUB_ENDPOINT: `${gatewayHost ?? new URL(publicUrl).hostname}:51820`,
  DEN_WG_HUB_AGENT_URL: 'http://wg-hub:8090',
  // Validations at submission (M4-06).
  DEN_VALIDATION_TOKEN: secret(32),
  DEN_GATEWAY_INTERNAL_URL: 'http://apisix:9080',
  // Access-log analytics (M5): the API reads OpenSearch and keeps its index template.
  DEN_OPENSEARCH_URL: 'http://opensearch:9200',
  // Metrics and alerts (M5-06): Prometheus scrapes the API's /metrics with this token; the
  // indicators read the gateway's availability from Prometheus; Grafana at /grafana.
  DEN_METRICS_TOKEN: secret(32),
  // APISIX's data_encryption key for the private keys in etcd: 16 characters (M6-01).
  DEN_APISIX_KEYRING: secret(12),
  // Encryption key of the pgBackRest repository (M6-06): without it no backup can be restored, so
  // a copy is kept off the server (OPERATIONS.md §6).
  PGBACKREST_REPO1_CIPHER_PASS: secret(32),
  // The proxy's address or network (M6-01): only it may set X-Forwarded-For, the caller's address
  // for rate limits and security events. Pass it when generating (DEN_TRUST_PROXY=172.30.0.2
  // node scripts/make-deploy-env.mjs ...); empty, the API trusts nobody (DEPLOYMENT.md).
  DEN_TRUST_PROXY: process.env.DEN_TRUST_PROXY ?? '',
  DEN_PROMETHEUS_URL: 'http://prometheus:9090',
  GRAFANA_ADMIN_PASSWORD: secret(16),
  GRAFANA_ROOT_URL: `${publicUrl.replace(/\/$/, '')}/grafana/`,
  GRAFANA_SERVE_FROM_SUB_PATH: 'true',
  DEN_CONTRACT_RUNNER_URL: 'http://contract-runner:8096',
  DEN_CONTRACT_RUNNER_TOKEN: secret(32),
  DEN_CONTRACT_RUNNER_GATEWAY_URL: 'http://apisix:9080',
  DEN_WG_HUB_AGENT_TOKEN: secret(32),
  // The CA's own keys (step-ca only), and one password per provisioner key, the API's (B-16):
  // infra/step-ca/configure.sh encrypts each provisioner's key with its own.
  STEP_CA_PASSWORD: stepCaPassword,
  DEN_STEP_CA_PROVISIONER_PASSWORD: secret(),
  DEN_STEP_CA_GATEWAY_PROVISIONER_PASSWORD: secret(),
  DEN_STEP_CA_NODE_PROVISIONER_PASSWORD: secret(),
  AUTH_SECRET: randomBytes(32).toString('base64'),
  // The proxy proves to the web that a request came through it (M-27, infra/edge/den.yml.template).
  DEN_WEB_PROXY_TOKEN: secret(32),
  DEN_SECRETS_KEY: randomBytes(32).toString('base64'),
  DEN_TRANSPARENCY_SIGNING_JWK: `'${JSON.stringify(signingJwk)}'`,
  DEN_TRANSPARENCY_LOG_ID: 'den-transparency',
  // Public URLs (one host; the reverse proxy routes by path).
  DEN_PUBLIC_URL: publicUrl,
  DEN_WEB_URL: publicUrl,
  AUTH_URL: publicUrl,
  KEYCLOAK_URL: `${publicUrl}/auth`,
  // With mTLS (features.mtls.required) applications reach the gateway on its own name, whose TLS
  // APISIX terminates; /gw on the portal's name only works without mTLS (DEPLOYMENT.md §5.2).
  DEN_GATEWAY_PUBLIC_URL: gatewayHost ? `https://${gatewayHost}` : `${publicUrl}/gw`,
  ...(gatewayHost ? { DEN_GATEWAY_TLS_HOSTS: gatewayHost } : {}),
  DEN_CITIZEN_ISSUER: `${publicUrl}/auth/realms/den-citizens`,
  DEN_CITIZEN_APP_URL: `${publicUrl}/citizen-app`,
  // Internal service names on the Compose network.
  DEN_API_URL: 'http://api:4000',
  APISIX_ADMIN_URL: 'http://apisix:9180',
  DEN_GATEWAY_KEYCLOAK_URL: 'http://keycloak:8080/auth',
  // Keycloak's Admin API for the API's reconciler, inside the network: not published (B-28).
  DEN_KEYCLOAK_ADMIN_URL: 'http://keycloak:8080/auth',
  OPA_PORTAL_URL: 'http://api:4000/api/v1/opa',
  DEN_TRANSPARENCY_COLLECTOR_HOST: 'api',
  DEN_TSA_URL: 'http://tsa:3004',
  // The pilot stamps with the development TSA: the API says so at every start. With the accredited
  // TSA, its full URL above, DEN_TSA_ROOTS_FILE and true here (DEPLOYMENT.md §3.7, ADR-0032).
  DEN_TSA_REQUIRE_INDEPENDENT: 'false',
  DEN_STEP_CA_URL: 'https://step-ca:9000',
  // The step-ca volume is mounted read-only in the API container (docker-compose.deploy.yml).
  DEN_STEP_CA_ROOT_FILE: '/var/lib/den/step-ca/root_ca.crt',
  // The API's mail (M-28): Mailpit on the Compose network until the operator names a real server.
  DEN_SMTP_URL: 'smtp://mailpit:1025',
  // The api-documents volume (docker-compose.deploy.yml); .env.example's value is for development.
  DEN_DOCUMENTS_DIR: '/var/lib/den/documents',
  TRAEFIK_NETWORK: values['traefik-network'],
  // Random unless asked, the one demo users share (it may be handed out at a workshop)...
  DEN_DEMO_USER_PASSWORD: `'${demoPassword ?? secret(12)}'`,
  // ...and always random for those with a critical role (platform administrator, operator,
  // regulator, auditor, data steward; M-29): `install.sh credentials` shows it.
  DEN_DEMO_CRITICAL_PASSWORD: secret(16),
  // Their one-time code key (M3-08): with the default, anyone could read it in the repo.
  DEN_DEMO_TOTP_SECRET: secret(20),
  MAILPIT_UI_AUTH: `mail:${secret(12)}`,
  // Notices (MT-06) to the reference citizen folder (MT-07), over the Compose network.
  DEN_CITIZEN_APPS: `'${JSON.stringify({
    'citizen-app': {
      webhookUrl: 'http://citizen-app:3100/citizen-app/api/den/alerts',
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
  'Demo users password: DEN_DEMO_USER_PASSWORD (critical roles: DEN_DEMO_CRITICAL_PASSWORD); ' +
    'one-time codes: pnpm demo:otp (DEN_DEMO_TOTP_SECRET); ' +
    'Mailpit login: MAILPIT_UI_AUTH (in that file).',
);
