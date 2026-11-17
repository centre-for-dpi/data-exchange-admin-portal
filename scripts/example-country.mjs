#!/usr/bin/env node
// `pnpm example:country [--keep]`: the portal brought up as a country it has never seen (M6-09).
// config/country/example.yaml, the template for a new country, becomes country XX; a stack of its
// own (Compose project `denxx`, every port shifted by 10000, its own volumes) runs the portal
// with it, and the demo of docs/DEMO.md goes through end to end: publication, review, catalogue,
// application, access request, calls through the gateway with the country's purposes and person
// document type, revocation, audit and the citizen's view. The web answers in both languages
// with the country's branding. The development stack is not touched.
//
// Needs Docker and the images of the development stack (`pnpm infra:up` once). Builds the API and
// the web. Without --keep, everything it created is removed at the end. Exits 1 on failure.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const PROJECT = 'denxx';
const SHIFT = 10_000;
const work = join(tmpdir(), 'den-example-country');
const log = (text) => console.log(text);
const ok = (text) => log(`   ✓ ${text}`);
class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};

// Ports of the development stack (docker-compose.yml) and of the portal on the host. The citizen
// folder (3100) is not started: its URL is only the redirect URI the realm already knows.
const PORT_VARS = {
  POSTGRES_PORT: 5432,
  KEYCLOAK_PORT: 8080,
  APISIX_HTTP_PORT: 9080,
  APISIX_HTTPS_PORT: 9443,
  APISIX_ADMIN_PORT: 9180,
  OPA_PORT: 8181,
  STEP_CA_PORT: 9000,
  OPENSEARCH_PORT: 9200,
  PROMETHEUS_PORT: 9090,
  ALERTMANAGER_PORT: 9093,
  GRAFANA_PORT: 3001,
  DEN_TSA_PORT: 3004,
  CLAMAV_PORT: 3310,
  MAILPIT_UI_PORT: 8025,
  MAILPIT_SMTP_PORT: 1025,
  MOCK_SALUD_PORT: 8101,
  MOCK_SOCIOECONOMICO_PORT: 8102,
  WG_HUB_UDP_PORT: 51820,
  WG_HUB_AGENT_PORT: 8095,
  CONTRACT_RUNNER_PORT: 8096,
};
const SHIFTED = new Set([...Object.values(PORT_VARS), 3000, 4000]);
const SERVICES = [
  'postgres',
  'keycloak',
  'etcd',
  'apisix',
  'opa',
  'step-ca',
  'tsa',
  'fluent-bit-transparency',
  'fluent-bit-errors',
  'mailpit',
  'mock-salud',
];

/** The environment of country XX: .env.example with every local port shifted. */
function countryEnv(configDir) {
  const env = {};
  for (const line of readFileSync(join(root, '.env.example'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^'(.*)'$/, '$1');
  }
  for (const [key, value] of Object.entries(env)) {
    env[key] = value.replace(
      /\b(localhost|127\.0\.0\.1|host\.docker\.internal):(\d+)\b/g,
      (all, host, port) => (SHIFTED.has(Number(port)) ? `${host}:${Number(port) + SHIFT}` : all),
    );
  }
  for (const [key, port] of Object.entries(PORT_VARS)) env[key] = String(port + SHIFT);
  return {
    ...env,
    COMPOSE_PROJECT_NAME: PROJECT,
    DEN_COUNTRY: 'XX',
    DEN_CONFIG_DIR: configDir,
    API_PORT: String(4000 + SHIFT),
    DEN_TRANSPARENCY_COLLECTOR_PORT: String(4000 + SHIFT),
    DEN_GATEWAY_HTTP_URL: `http://localhost:${9080 + SHIFT}`,
    // The provider mock checks the gateway's assertion with this portal's keys (M6-10).
    MOCK_GATEWAY_JWKS_URL: `http://host.docker.internal:${4000 + SHIFT}/api/v1/gateway/jwks`,
    DEN_DOCUMENTS_DIR: join(work, 'documents'),
    NODE_ENV: 'development',
  };
}

function run(command, commandArgs, options = {}) {
  const r = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 1_800_000,
    ...options,
  });
  if (r.status !== 0)
    fail(`${command} ${commandArgs.join(' ')}:\n${(r.stderr || r.stdout).slice(-3000)}`);
  return r.stdout;
}

const children = [];
function start(name, command, commandArgs, options) {
  const out = openSync(join(work, `${name}.log`), 'w');
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: ['ignore', out, out],
    shell: process.platform === 'win32',
    ...options,
  });
  children.push(child);
  return child;
}

async function waitFor(url, what, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const okay = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (okay) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`${what} did not answer at ${url}`);
}

/** The demo citizen's document type is the first person type of the country (Keycloak admin). */
async function citizenDocumentType(env, documentType) {
  const keycloak = env.KEYCLOAK_URL;
  const token = await (
    await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: env.KEYCLOAK_ADMIN_USER,
        password: env.KEYCLOAK_ADMIN_PASSWORD,
      }),
    })
  ).json();
  const headers = {
    authorization: `Bearer ${token.access_token}`,
    'content-type': 'application/json',
  };
  const users = await (
    await fetch(`${keycloak}/admin/realms/den-citizens/users?username=ciudadana.demo&exact=true`, {
      headers,
    })
  ).json();
  const user = users[0] ?? fail('ciudadana.demo is not in the den-citizens realm');
  const res = await fetch(`${keycloak}/admin/realms/den-citizens/users/${user.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ...user,
      attributes: { ...user.attributes, document_type: [documentType] },
    }),
  });
  if (!res.ok) fail(`could not set the citizen's document type: ${res.status}`);
}

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'documents'), { recursive: true });

  log('1. Country XX from config/country/example.yaml');
  const configDir = join(work, 'config');
  cpSync(join(root, 'config/country'), configDir, { recursive: true });
  cpSync(join(configDir, 'example.yaml'), join(configDir, 'xx.yaml'));
  const env = { ...process.env, ...countryEnv(configDir) };
  const { loadCountryConfig } = await import(
    `file://${join(root, 'packages/config/dist/index.js').replace(/\\/g, '/')}`
  );
  const country = loadCountryConfig({ env });
  ok(
    `${country.country.name} (${country.country.code}, ${country.country.locale}): sectors ` +
      `${country.sectors.map((s) => s.code).join(', ')}; person documents ` +
      `${country.identifiers.person.join(', ')}`,
  );
  writeFileSync(
    join(work, 'xx.env'),
    Object.entries(countryEnv(configDir))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );

  log(`2. Its stack (Compose project ${PROJECT}, ports + ${SHIFT})`);
  const compose = [
    'compose',
    '-p',
    PROJECT,
    '-f',
    'infra/compose/docker-compose.yml',
    '--env-file',
    join(work, 'xx.env'),
  ];
  // --build: the images built from this repository (PostgreSQL, the provider mock) as they are now.
  run(
    'docker',
    [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '600', ...SERVICES],
    {
      env,
    },
  );
  ok(SERVICES.join(', '));

  log('3. The portal for XX: build, migrate, seed, start');
  run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@den/api', '--filter=@den/web...'], {
    env,
  });
  run('pnpm', ['--filter', '@den/api', 'db:deploy'], { env });
  run('pnpm', ['--filter', '@den/api', 'db:seed'], { env });
  start('api', 'node', ['--enable-source-maps', 'dist/main.js'], {
    cwd: join(root, 'apps/api'),
    env,
  });
  await waitFor(`${env.DEN_API_URL}/api/v1/health`, 'the portal API');
  start('web', 'pnpm', ['exec', 'next', 'start', '--port', String(3000 + SHIFT)], {
    cwd: join(root, 'apps/web'),
    env,
  });
  await waitFor(`${env.DEN_WEB_URL}/api/auth/providers`, 'the web');
  ok(`API ${env.DEN_API_URL}, web ${env.DEN_WEB_URL}`);

  log('4. The web in both languages, with the country’s branding');
  for (const path of ['/', '/en']) {
    const html = await (await fetch(`${env.DEN_WEB_URL}${path}`)).text();
    if (!html.includes(country.branding.productName)) {
      fail(`${path} does not show the product name "${country.branding.productName}"`);
    }
    const lang = /<html[^>]*lang="([a-z]+)"/.exec(html)?.[1];
    if (lang !== (path === '/en' ? 'en' : 'es')) fail(`${path} is served as lang="${lang}"`);
    ok(`${path}: lang="${lang}", "${country.branding.productName}"`);
  }
  const logo = await fetch(`${env.DEN_WEB_URL}/branding/logo`);
  if (!logo.ok) fail(`the country's logo: ${logo.status}`);
  ok('the country’s logo');

  log('5. The demo, end to end');
  await citizenDocumentType(env, country.identifiers.person[0]);
  const verifier = join(root, 'packages/transparency-verifier/dist/index.js');
  if (!existsSync(verifier))
    run('pnpm', ['--filter', '@den/transparency-verifier', 'build'], { env });
  const demo = spawnSync(process.execPath, [join(root, 'scripts/demo.mjs')], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 900_000,
  });
  writeFileSync(join(work, 'demo.log'), `${demo.stdout}${demo.stderr}`);
  if (demo.status !== 0)
    fail(
      `the demo failed (${join(work, 'demo.log')}):\n${demo.stdout.slice(-2500)}${demo.stderr.slice(-1500)}`,
    );
  const steps = (demo.stdout.match(/^\d+\. /gm) ?? []).length;
  ok(`the demo passed: ${steps} steps, ${demo.stdout.trim().split('\n').at(-1)}`);

  log('\nExample country passed.');
}

function cleanup() {
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else child.kill();
  }
  if (args.keep) {
    log(`\nKept: project ${PROJECT} and ${work}`);
    return;
  }
  spawnSync('docker', ['compose', '-p', PROJECT, 'down', '-v', '--remove-orphans'], {
    cwd: root,
    stdio: 'ignore',
  });
}

try {
  await main();
} catch (error) {
  console.error(`\n✗ ${error instanceof Failure ? error.message : (error.stack ?? String(error))}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
