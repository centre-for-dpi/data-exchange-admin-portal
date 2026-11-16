#!/usr/bin/env node
// `pnpm helm:sync [--check]`: copies into the Helm chart (infra/helm/rid/files) the configuration
// files it shares with Compose: Helm only reads files inside the chart's directory. The repository's
// files stay the source; `--check` (CI, tests/infra) fails when a copy differs from its source.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
};

const check = process.argv.includes('--check');
const drift = [];
for (const [source, target] of Object.entries(SHARED)) {
  const from = resolve(root, source);
  const to = resolve(chartFiles, target);
  if (!existsSync(from)) {
    drift.push(`${source}: missing`);
    continue;
  }
  if (check) {
    if (!existsSync(to) || !readFileSync(from).equals(readFileSync(to))) {
      drift.push(`${target} differs from ${source}`);
    }
  } else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}
if (drift.length > 0) {
  console.error(`Helm chart files out of date (run \`pnpm helm:sync\`):\n  ${drift.join('\n  ')}`);
  process.exit(1);
}
if (!check) console.log(`Copied ${Object.keys(SHARED).length} files into infra/helm/rid/files`);
