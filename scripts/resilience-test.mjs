#!/usr/bin/env node
// `pnpm resilience:test [--outage 45s] [--portal-container rid-api-1]`: the gateway without the
// portal (M6-04). The portal is the control plane: APISIX keeps its routes in etcd, OPA its last
// bundle (in memory and, since M6-04, on disk), Keycloak issues the tokens and the transparency
// pipeline buffers on disk. This script checks, against the running stack:
//   1. with the portal down, allowed calls keep going through and denials keep being decided;
//   2. OPA restarted while the portal is down starts with its last bundle (not with no policy,
//      which would deny everything), and so does APISIX with its routes;
//   3. when the portal is back, no call of the outage is missing from the transparency register,
//      and changes reach the gateway again (a revocation denies within the bundle's minute).
// The portal is stopped and started through its container (pilot: rid-api-1) or, when there is
// none (development), as this script's own process (apps/api/dist/main.js; build it first and
// stop `pnpm dev`). Exits 1 at the first expectation that does not hold.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const {
  API,
  callingApplication,
  expect,
  GATEWAY,
  gatewayFetch,
  gatewayToken,
  ScriptError,
  TEST_PERSON,
  waitFor,
} = await import('./lib/portal.mjs');

const { values: args } = parseArgs({
  options: {
    outage: { type: 'string', default: '45s' },
    'portal-container': { type: 'string' },
  },
});
const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? 'rid';
const container = (service) => `${PROJECT}-${service}-1`;
const OUTAGE_S = Number(/^(\d+)s$/.exec(args.outage)?.[1] ?? 'NaN');
const log = (text) => console.log(text);
const ok = (text) => log(`   ✓ ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 });
const containerExists = (name) => docker('inspect', name).status === 0;
const healthy = (name) =>
  docker('inspect', '--format', '{{.State.Health.Status}}', name).stdout.trim() === 'healthy';
const apiUp = () =>
  fetch(`${API}/health`).then(
    (r) => r.ok,
    () => false,
  );

/** The portal API: its container in the pilot, or a process of this script in development. */
function portalControl() {
  const name = args['portal-container'] ?? container('api');
  if (containerExists(name)) {
    return {
      what: `contenedor ${name}`,
      start: async () => void docker('start', name),
      stop: async () => void docker('stop', name),
      done: async () => {},
    };
  }
  let child;
  const logFile = join(tmpdir(), `rid-resilience-api-${Date.now()}.log`);
  return {
    what: `proceso propio (apps/api/dist/main.js, log en ${logFile})`,
    start: async () => {
      const out = openSync(logFile, 'a');
      child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
        cwd: resolve(root, 'apps/api'),
        stdio: ['ignore', out, out],
      });
    },
    stop: async () => {
      child?.kill();
      child = undefined;
    },
    done: async () => {
      child?.kill();
    },
  };
}

/** Whether OPA has its bundle activated, asked from inside its container (no port needed). */
const opaHasBundle = () =>
  docker(
    'exec',
    container('opa'),
    '/opa',
    'eval',
    '--fail',
    'r := http.send({"method": "get", "url": "http://127.0.0.1:8181/health?bundles=true"}); r.status_code == 200',
  ).status === 0;

/** subject_access_record rows of the subscription with the given status (ADR-0015). */
function registered(subscriptionId, status) {
  const res = docker(
    'exec',
    container('postgres'),
    'psql',
    '-U',
    process.env.POSTGRES_USER ?? 'rid',
    '-d',
    process.env.POSTGRES_DB ?? 'rid',
    '-At',
    '-c',
    `SELECT count(*) FROM subject_access_record WHERE subscription_id = '${subscriptionId}' AND status = ${status}`,
  );
  expect(res.status === 0, `could not read the transparency register: ${res.stderr}`);
  return Number(res.stdout.trim());
}

async function main() {
  expect(OUTAGE_S >= 25, 'the outage must cover a bundle poll at least: 25s or more');
  log(`Resiliencia del gateway sin el portal (M6-04): caída de ${OUTAGE_S} s`);
  const portal = portalControl();
  log(`Portal: ${portal.what}`);
  expect(
    portal.what.startsWith('contenedor') || !(await apiUp()),
    'the portal API is already running outside this script (pnpm dev?): stop it, so the script can stop and start its own, or pass --portal-container',
  );
  if (!(await apiUp())) {
    await portal.start();
    await waitFor(apiUp, { timeoutMs: 120_000, what: 'the portal API did not start' });
  }
  try {
    await run(portal);
  } finally {
    await portal.done();
  }
}

async function run(portal) {
  log('\n1. Una aplicación con suscripción activa');
  const target = await callingApplication({
    slug: `resiliencia-${Date.now().toString(36)}`,
    purpose: 'Prueba de resiliencia del gateway (M6-04).',
    log,
  });
  const token = await gatewayToken(target.clientId, target.clientSecret);
  const call = async (purpose = 'eligibility_check') => {
    const res = await gatewayFetch(`${GATEWAY}${target.path.replace('{n}', TEST_PERSON)}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-rid-purpose': purpose,
        'x-rid-end-user': 'funcionario-resiliencia',
      },
    }).catch((error) => ({ status: 0, headers: new Headers(), error }));
    return { status: res.status, reason: res.headers.get('x-rid-deny-reason') };
  };
  const expectAllowed = async (when) => {
    const r = await call();
    expect(r.status === 200, `${when}: expected 200, got ${r.status} ${r.reason ?? ''}`);
  };
  const expectDenied = async (when) => {
    const r = await call('benefit_targeting');
    expect(
      r.status === 403 && r.reason === 'purpose_not_allowed',
      `${when}: expected 403 purpose_not_allowed, got ${r.status} ${r.reason ?? ''}`,
    );
  };
  await expectAllowed('before the outage');
  await expectDenied('before the outage');
  const before = registered(target.subscriptionId, 200);
  ok('Antes de la caída: llamada permitida 200, finalidad no aprobada 403');

  log(`\n2. Portal caído durante ${OUTAGE_S} s`);
  await portal.stop();
  await waitFor(async () => !(await apiUp()), {
    timeoutMs: 60_000,
    what: 'the portal API is still answering',
  });
  ok('El API del portal no responde');
  let allowed = 0;
  const until = Date.now() + OUTAGE_S * 1000;
  while (Date.now() < until) {
    await expectAllowed('with the portal down');
    allowed += 1;
    await expectDenied('with the portal down');
    await sleep(1_000);
  }
  ok(`${allowed} llamadas permitidas y ${allowed} negadas, cada una como debía, sin el portal`);
  expect(opaHasBundle(), 'OPA lost its bundle while the portal was down');
  ok('OPA conserva el último bundle aunque no puede descargar uno nuevo');

  log('\n3. OPA y APISIX reiniciados sin el portal');
  docker('restart', container('opa'));
  await waitFor(() => healthy(container('opa')) && opaHasBundle(), {
    timeoutMs: 120_000,
    what: 'OPA did not start with its persisted bundle',
  });
  await waitFor(async () => (await call()).status === 200, {
    timeoutMs: 30_000,
    what: 'calls do not go through after restarting OPA',
  });
  allowed += 1;
  await expectDenied('after restarting OPA');
  ok('OPA arrancó con el bundle guardado en disco: permite y niega como antes');
  docker('restart', container('apisix'));
  await waitFor(() => healthy(container('apisix')), {
    timeoutMs: 120_000,
    what: 'APISIX did not start',
  });
  await waitFor(async () => (await call()).status === 200, {
    timeoutMs: 60_000,
    what: 'calls do not go through after restarting APISIX',
  });
  allowed += 1;
  ok('APISIX arrancó con sus rutas desde etcd');

  log('\n4. El portal vuelve');
  await portal.start();
  await waitFor(apiUp, { timeoutMs: 120_000, what: 'the portal API did not come back' });
  ok('El API del portal responde');
  // Fluent Bit kept the records of the outage on disk and retries until the portal takes them.
  await waitFor(() => registered(target.subscriptionId, 200) >= before + allowed, {
    timeoutMs: 180_000,
    what: `the transparency register is missing calls of the outage (${before + allowed} expected)`,
  });
  ok(`Registro de transparencia completo: las ${allowed} consultas de la caída están`);
  const { actor: lucia, entityId: salud } = target.provider;
  await lucia.call('POST', `/entities/${salud}/access-requests/${target.subscriptionId}/revoke`, {
    comment: 'Fin de la prueba de resiliencia.',
  });
  const revokedAt = Date.now();
  await waitFor(
    async () => {
      const r = await call();
      return r.status === 403 && r.reason === 'no_subscription';
    },
    { timeoutMs: 90_000, what: 'the revocation did not reach the gateway' },
  );
  ok(
    `Los cambios vuelven a llegar: la revocación negó la llamada en ${((Date.now() - revokedAt) / 1000).toFixed(0)} s`,
  );
  log('\nResiliencia en verde');
}

main().catch((error) => {
  console.error(error instanceof ScriptError ? `\n✗ ${error.message}` : error);
  process.exit(1);
});
