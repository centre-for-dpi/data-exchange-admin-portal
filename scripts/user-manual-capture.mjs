#!/usr/bin/env node
// Regenerates the user manual's screenshots (docs/guides/user-manual.md) from the real portal:
// for each language it resets the local stack, migrates and seeds it, runs the capture journey
// (apps/web/e2e/manual/journey.manual.ts) and finally rebuilds the manual's HTML.
//
//   pnpm docs:manual --yes [--lang es|en|all]
//
// It WIPES the local Docker volumes (pnpm infra:reset): Postgres, Keycloak, OpenSearch... The
// portal's API and web must not be running (they would keep connections to the old stack): the
// journey starts them itself.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const langArg = args[args.indexOf('--lang') + 1];
const langs = args.includes('--lang') && langArg !== 'all' ? [langArg] : ['es', 'en'];

if (!args.includes('--yes')) {
  console.error(
    'This wipes the local Docker volumes (pnpm infra:reset) and captures the user manual again.\n' +
      'Run it with --yes to go ahead: pnpm docs:manual --yes [--lang es|en|all]',
  );
  process.exit(1);
}
if (langs.some((l) => !['es', 'en'].includes(l))) {
  console.error(`Unknown language: ${langs.join(', ')} (es, en or all)`);
  process.exit(1);
}

const api = process.env.DEN_API_URL ?? 'http://localhost:4000';
const running = await fetch(`${api}/api/v1/health`).then(
  () => true,
  () => false,
);
if (running) {
  console.error(
    `The portal's API answers at ${api}: stop the API and the web app first, the capture starts them on the fresh stack.`,
  );
  process.exit(1);
}

function run(command, env = {}) {
  console.log(`\n$ ${command}`);
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const lang of langs) {
  run('pnpm infra:reset');
  run('pnpm infra:up');
  run('pnpm db:deploy');
  run('pnpm db:seed');
  run(
    'pnpm --filter @den/web exec playwright test -c e2e/manual/playwright.manual.config.ts --project journey',
    { MANUAL_LANG: lang },
  );
}
run('node scripts/user-manual-html.mjs');
