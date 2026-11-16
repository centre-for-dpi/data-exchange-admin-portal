#!/usr/bin/env node
// `pnpm helm:sync [--check]`: copies into the Helm chart (infra/helm/rid/files) the configuration
// files it shares with Compose: Helm only reads files inside the chart's directory. The repository's
// files stay the source; `--check` (CI, tests/infra) fails when a copy differs from its source.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartFiles = resolve(root, 'infra/helm/rid/files');

/** Source in the repository -> path under the chart's files/. */
export const SHARED = {
  'infra/apisix/plugins/apisix/plugins/rid-assertion.lua': 'apisix/plugins/rid-assertion.lua',
  'infra/apisix/plugins/apisix/plugins/rid-client-cert.lua': 'apisix/plugins/rid-client-cert.lua',
  'infra/apisix/plugins/apisix/plugins/rid-data-subject.lua': 'apisix/plugins/rid-data-subject.lua',
  'infra/apisix/plugins/apisix/plugins/rid-header-guard.lua': 'apisix/plugins/rid-header-guard.lua',
  'infra/apisix/plugins/apisix/plugins/rid-rate-limited.lua': 'apisix/plugins/rid-rate-limited.lua',
  'infra/fluent-bit/allowlist.lua': 'fluent-bit/allowlist.lua',
  'infra/fluent-bit/transparency.lua': 'fluent-bit/transparency.lua',
  'infra/fluent-bit/transparency.yaml': 'fluent-bit/transparency.yaml',
  'infra/fluent-bit/gateway-errors.lua': 'fluent-bit/gateway-errors.lua',
  'infra/fluent-bit/gateway-errors.yaml': 'fluent-bit/gateway-errors.yaml',
  'infra/prometheus/rules/rid.rules.yml': 'prometheus/rid.rules.yml',
  'infra/alertmanager/alertmanager.yml': 'alertmanager/alertmanager.yml',
  'infra/grafana/dashboards/rid-operator.json': 'grafana/rid-operator.json',
  'infra/opa/config.yaml': 'opa/config.yaml',
  'infra/step-ca/app.tpl': 'step-ca/app.tpl',
  'infra/step-ca/gateway.tpl': 'step-ca/gateway.tpl',
  'infra/step-ca/node.tpl': 'step-ca/node.tpl',
  'infra/keycloak/rid-portal-realm.json': 'keycloak/rid-portal-realm.json',
  'infra/keycloak/rid-gateway-realm.json': 'keycloak/rid-gateway-realm.json',
  'infra/keycloak/rid-citizens-realm.json': 'keycloak/rid-citizens-realm.json',
};

/**
 * Production realms (M6-05): the development ones without their people. The demo users (with
 * their passwords and one-time code keys) never reach a production Keycloak; the service accounts
 * of the clients stay, the clients need them.
 */
export function productionRealm(source) {
  const realm = JSON.parse(source);
  realm.users = (realm.users ?? []).filter((user) => user.serviceAccountClientId);
  return `${JSON.stringify(realm, null, 2)}\n`;
}

/** What the chart holds of a source file: itself, or its production form. */
const contentOf = (source, from) =>
  source.startsWith('infra/keycloak/')
    ? Buffer.from(productionRealm(readFileSync(from, 'utf8')))
    : readFileSync(from);

const check = process.argv.includes('--check');
const drift = [];
for (const [source, target] of Object.entries(SHARED)) {
  const from = resolve(root, source);
  const to = resolve(chartFiles, target);
  if (!existsSync(from)) {
    drift.push(`${source}: missing`);
    continue;
  }
  const content = contentOf(source, from);
  if (check) {
    if (!existsSync(to) || !content.equals(readFileSync(to))) {
      drift.push(`${target} differs from ${source}`);
    }
  } else {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
  }
}
if (drift.length > 0) {
  console.error(`Helm chart files out of date (run \`pnpm helm:sync\`):\n  ${drift.join('\n  ')}`);
  process.exit(1);
}
if (!check) console.log(`Copied ${Object.keys(SHARED).length} files into infra/helm/rid/files`);
