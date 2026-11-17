#!/usr/bin/env node
// `pnpm load:test [--rate 500] [--duration 5m] [--warmup 30s] [--seed]`: the load test of the
// gateway (M6-03, SPEC.md §9). With the network at its initial scale (`--seed` runs
// `pnpm load:seed` first: 200 entities, 1,000 APIs, 5,000 subscriptions), an application calls a
// published API at RATE requests per second for DURATION, through the full production chain:
// mTLS, a token bound to the certificate, OPA, rate limit and access log. Passes when:
//   - the latency the gateway adds (APISIX's own time, without the provider) has p95 < 50 ms,
//     measured by APISIX itself in Prometheus for the test's route;
//   - fewer than 1% of the calls fail and k6 sustains the rate (tests/load/gateway.js).
// Prerequisites: `pnpm infra:up` and the portal running, as for `pnpm demo`. Exits 1 otherwise.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const { API, callingApplication, expect, GATEWAY, ScriptError, tls } =
  await import('./lib/portal.mjs');

const { values: args } = parseArgs({
  options: {
    rate: { type: 'string', default: '500' },
    duration: { type: 'string', default: '5m' },
    warmup: { type: 'string', default: '30s' },
    seed: { type: 'boolean', default: false },
  },
});
const RATE = Number(args.rate);
const P95_LIMIT_MS = 50;
const K6_IMAGE = 'grafana/k6:2.3.0';
const PROMETHEUS = process.env.DEN_PROMETHEUS_PUBLIC_URL ?? 'http://localhost:9090';

const seconds = (text) => {
  const m = /^(\d+)(s|m)$/.exec(text);
  expect(m, `durations are like 30s or 5m, not ${text}`);
  return Number(m[1]) * (m[2] === 'm' ? 60 : 1);
};
const log = (text) => console.log(text);

async function preflight() {
  for (const [name, url] of [
    ['portal API', `${API}/health`],
    ['Prometheus', `${PROMETHEUS}/-/ready`],
  ]) {
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    expect(ok, `${name} is not reachable at ${url}`);
  }
  const docker = spawnSync('docker', ['image', 'inspect', K6_IMAGE], { encoding: 'utf8' });
  if (docker.status !== 0) {
    const pull = spawnSync('docker', ['pull', K6_IMAGE], { stdio: 'inherit' });
    expect(pull.status === 0, `could not pull ${K6_IMAGE}`);
  }
}

/** k6 in its container, outside the stack's networks, like any consumer. */
function runK6(target) {
  const dir = mkdtempSync(join(tmpdir(), 'den-load-'));
  try {
    writeFileSync(join(dir, 'gateway.js'), readFileSync(resolve(root, 'tests/load/gateway.js')));
    writeFileSync(join(dir, 'app.crt'), tls.client.cert);
    writeFileSync(join(dir, 'app.key'), tls.client.key);
    const gateway = new URL(GATEWAY);
    // A gateway on this machine is reached at the host's address, with its own name (SNI).
    const local = ['localhost', '127.0.0.1'].includes(gateway.hostname);
    const env = {
      GATEWAY: gateway.origin,
      CLIENT_ID: target.clientId,
      CLIENT_SECRET: target.clientSecret,
      PATH_TEMPLATE: target.path,
      RATE: String(RATE),
      DURATION: args.duration,
      WARMUP: args.warmup,
      DEBUG: process.env.DEN_LOAD_DEBUG ?? '',
    };
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        ...(local ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
        '-v',
        `${dir}:/load`,
        ...Object.keys(env).flatMap((k) => ['-e', k]),
        '--entrypoint',
        'sh',
        K6_IMAGE,
        '-c',
        local
          ? 'GATEWAY_IP=$(getent ahostsv4 host.docker.internal | head -1 | cut -d" " -f1) exec k6 run --quiet /load/gateway.js'
          : 'exec k6 run --quiet /load/gateway.js',
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, ...env, MSYS_NO_PATHCONV: '1' },
      },
    );
    const file = join(dir, 'summary.json');
    expect(existsSync(file), `k6 did not finish (exit ${result.status}): see its output above`);
    const summary = JSON.parse(readFileSync(file, 'utf8'));
    // The sustained phase is the last one: it ends when k6 does.
    return { status: result.status, summary, finished: Date.now() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function prometheus(query, at) {
  const url = `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(query)}&time=${at / 1000}`;
  const body = await (await fetch(url)).json();
  const value = body.data?.result?.[0]?.value?.[1];
  return value === undefined || value === 'NaN' ? undefined : Number(value);
}

async function main() {
  const duration = seconds(args.duration);
  seconds(args.warmup); // validated: k6 takes it as is
  log(`Prueba de carga del gateway (M6-03): ${RATE} peticiones/s durante ${args.duration}`);
  await preflight();
  if (args.seed) {
    log('\nRed a la escala inicial (pnpm load:seed)');
    const seed = spawnSync('pnpm', ['load:seed'], { cwd: root, stdio: 'inherit', shell: true });
    expect(seed.status === 0, 'the load seed failed');
  }
  log('\nPreparando la aplicación que llama');
  const target = await callingApplication({
    slug: `carga-objetivo-${Date.now().toString(36)}`,
    purpose: 'Prueba de carga del gateway (M6-03).',
    // Room for the test: twice the rate.
    rateLimitPerMinute: RATE * 60 * 2,
    log,
  });

  log(`\nk6 (${K6_IMAGE})`);
  const k6 = runK6(target);
  // Prometheus needs one more scrape to have the last sample of the sustained phase.
  const end = k6.finished;
  await new Promise((r) => setTimeout(r, 35_000));
  const route = `route="den-route-${target.versionId}"`;
  const window = `${duration}s`;
  const quantile = (q, type) =>
    prometheus(
      `histogram_quantile(${q}, sum by (le) (increase(apisix_http_latency_bucket{type="${type}",${route}}[${window}])))`,
      end,
    );
  const gateway = {
    p50: await quantile(0.5, 'apisix'),
    p95: await quantile(0.95, 'apisix'),
    p99: await quantile(0.99, 'apisix'),
  };
  const upstream95 = await quantile(0.95, 'upstream');
  const request95 = await quantile(0.95, 'request');
  const served = await prometheus(`sum(increase(apisix_http_status{${route}}[${window}]))`, end);
  const metrics = k6.summary.metrics;
  const failed =
    metrics['http_req_failed{phase:sustained}']?.values?.rate ??
    metrics.http_req_failed?.values?.rate;
  const dropped = metrics.dropped_iterations?.values?.count ?? 0;
  const calls = metrics['http_reqs{phase:sustained,name:call}']?.values?.count ?? 0;
  const client95 =
    metrics['http_req_duration{name:call}']?.values?.['p(95)'] ??
    metrics.http_req_duration?.values?.['p(95)'];

  const ms = (v) => (v === undefined ? '—' : `${v.toFixed(1)} ms`);
  log('\nResultado');
  log(
    `  Llamadas de la fase sostenida: ${calls} (${(calls / duration).toFixed(0)}/s) · el gateway registró ${served?.toFixed(0) ?? '—'} en la ventana`,
  );
  log(
    `  Latencia que agrega el gateway: p50 ${ms(gateway.p50)} · p95 ${ms(gateway.p95)} · p99 ${ms(gateway.p99)}`,
  );
  log(
    `  Proveedor (upstream) p95 ${ms(upstream95)} · petición completa en el gateway p95 ${ms(request95)}`,
  );
  log(
    `  Visto por el cliente p95 ${ms(client95)} · fallidas ${((failed ?? 0) * 100).toFixed(2)} % · no lanzadas ${dropped}`,
  );

  const verdicts = [
    [
      gateway.p95 !== undefined && gateway.p95 < P95_LIMIT_MS,
      `p95 agregado por el gateway < ${P95_LIMIT_MS} ms`,
    ],
    [calls / duration >= RATE * 0.95, `${RATE} peticiones/s sostenidas`],
    [k6.status === 0, 'umbrales de k6 (fallidas < 1 %, tasa sostenida)'],
  ];
  for (const [ok, what] of verdicts) log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (verdicts.some(([ok]) => !ok)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof ScriptError ? `\n✗ ${error.message}` : error);
  process.exit(1);
});
