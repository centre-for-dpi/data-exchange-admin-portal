#!/usr/bin/env node
// Automated run of docs/DEMO.md (M1-12) against the local stack, as the five demo characters.
// Prerequisites: `pnpm infra:up` and the portal running (`pnpm dev`). Exits 1 at the first step
// that does not behave as the script promises the audience.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const env = (name, fallback) => process.env[name] ?? fallback;
const API = `${env('RID_API_URL', 'http://localhost:4000')}/api/v1`;
const KEYCLOAK = env('KEYCLOAK_URL', 'http://localhost:8080');
const GATEWAY = env('RID_GATEWAY_PUBLIC_URL', 'http://localhost:9080');
const WEB = env('RID_WEB_URL', 'http://localhost:3000');
const PASSWORD = env('RID_DEMO_USER_PASSWORD', 'demo');
const RUN = Date.now().toString(36);
const SLUG = `afiliacion-${RUN}`;

// --- Output ----------------------------------------------------------------------------------

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color('1');
const green = color('32');
const red = color('31');
const dim = color('2');
const started = Date.now();
let stepNo = 0;

function step(title, who) {
  stepNo += 1;
  console.log(`\n${bold(`${stepNo}. ${title}`)}${who ? dim(`  (${who})`) : ''}`);
}
const ok = (text) => console.log(`   ${green('✓')} ${text}`);
const info = (text) => console.log(`   ${dim(text)}`);

class DemoError extends Error {}
function expect(condition, message) {
  if (!condition) throw new DemoError(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repeats `probe` every `everyMs` until it returns a truthy value or `timeoutMs` passes. */
async function waitFor(probe, { timeoutMs, everyMs = 1_000, what }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new DemoError(`Timed out after ${timeoutMs / 1000} s: ${what}`);
    await sleep(everyMs);
  }
}

// --- Keycloak login (Authorization Code + PKCE, like the web app) ------------------------------

async function login(username) {
  const realm = `${KEYCLOAK}/realms/rid-portal/protocol/openid-connect`;
  const redirectUri = `${WEB}/api/auth/callback/keycloak`;
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: env('RID_PORTAL_WEB_CLIENT_ID', 'rid-portal-web'),
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const cookies = new Map();
  const keep = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const page = await fetch(`${realm}/auth?${params}`, { redirect: 'manual' });
  keep(page);
  const action = /<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/.exec(await page.text())?.[1];
  expect(action, `Keycloak login form not found for ${username}`);
  const submitted = await fetch(action.replaceAll('&amp;', '&'), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: new URLSearchParams({ username, password: PASSWORD, credentialId: '' }),
  });
  const code = new URL(submitted.headers.get('location') ?? 'http://x/').searchParams.get('code');
  expect(code, `Login failed for ${username} (is RID_DEMO_USER_PASSWORD right?)`);
  const clientId = env('RID_PORTAL_WEB_CLIENT_ID', 'rid-portal-web');
  const secret = env('RID_PORTAL_WEB_CLIENT_SECRET', '');
  const tokens = await fetch(`${realm}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  expect(tokens.ok, `Token exchange failed for ${username}: ${tokens.status}`);
  return (await tokens.json()).access_token;
}

/** A character of DEMO.md: calls the portal API with their own session. */
async function as(username) {
  const token = await login(username);
  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    expect(res.ok, `${username}: ${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  const me = await call('GET', '/me');
  const entity = (slug) => {
    const found = me.memberships.find((m) => m.entity.slug === slug);
    expect(found, `${username} does not belong to ${slug}`);
    return found.entity.id;
  };
  return { call, entity, username };
}

// --- Gateway -----------------------------------------------------------------------------------

async function gatewayToken(clientId, clientSecret) {
  const res = await fetch(`${KEYCLOAK}/realms/rid-gateway/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  expect(res.ok, `client_credentials token failed: ${res.status}`);
  return (await res.json()).access_token;
}

const PERSON = '1000000001';
const URL_PATH = `/salud/${SLUG}/v1/afiliados/${PERSON}`;

async function callGateway(token, headers = {}) {
  const res = await fetch(`${GATEWAY}${URL_PATH}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, reason: res.headers.get('x-rid-deny-reason'), body };
}

/** X-RID-* headers the provider (salud mock) logged for one request. */
function providerSaw(requestId) {
  const logs = spawnSync('docker', ['logs', '--since', '2m', 'rid-mock-salud-1'], {
    encoding: 'utf8',
  });
  for (const line of `${logs.stdout}${logs.stderr}`.split('\n')) {
    if (!line.includes(requestId)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.rid?.['x-request-id'] === requestId) return entry.rid;
    } catch {
      // not a JSON log line
    }
  }
  return undefined;
}

// --- Script ------------------------------------------------------------------------------------

async function preflight() {
  const checks = [
    ['portal API', `${API}/health`],
    ['Keycloak', `${KEYCLOAK}/realms/rid-portal`],
    ['gateway', `${GATEWAY}/`],
  ];
  for (const [name, url] of checks) {
    const reachable = await fetch(url).then(
      () => true,
      () => false,
    );
    expect(
      reachable,
      `${name} is not reachable at ${url}. Run \`pnpm infra:up\` and \`pnpm dev\`.`,
    );
  }
}

async function main() {
  console.log(bold('Demo M1 — Red de Intercambio de Datos (docs/DEMO.md)'));
  info(`API de esta corrida: /salud/${SLUG}/v1 · datos ficticios`);
  await preflight();

  step('Publicar la API "Consulta de afiliación"', 'pedro.publicador');
  const pedro = await as('pedro.publicador');
  const salud = pedro.entity('salud');
  const api = await pedro.call('POST', `/entities/${salud}/apis`, {
    slug: SLUG,
    name: `Consulta de afiliación (demo ${RUN})`,
    summary: 'Consulta el estado de afiliación de una persona al sistema de salud.',
    description: 'API de demostración con datos sintéticos.',
    sector: 'salud',
    tags: ['afiliacion'],
    classification: 'personal',
    ownerContact: 'apis@salud.demo.rid.example',
  });
  const version = await pedro.call('POST', `/entities/${salud}/apis/${api.id}/versions`, {
    version: '1.0',
    openapi: readFileSync(resolve(root, 'infra/mock-providers/salud/openapi.yaml'), 'utf8'),
    upstream: { type: 'node', servicePath: '/salud' },
    allowedPurposes: ['eligibility_check'],
    exposedFields: [
      { name: 'regimen', personal: true, sensitive: false },
      { name: 'estado', personal: true, sensitive: false },
      { name: 'aseguradora', personal: false, sensitive: false },
    ],
  });
  ok(`OpenAPI cargado: ${version.operations.length} operaciones, lint sin errores`);
  await pedro.call('POST', `/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`);
  ok('Versión 1.0 enviada a revisión');

  step('Revisar y aprobar', 'ana.operadora');
  const ana = await as('ana.operadora');
  const review = await ana.call('GET', `/review/api-versions/${version.id}`);
  info(`Datos que expone: ${review.version.exposedFields.map((f) => f.name).join(', ')}`);
  const approved = await ana.call('POST', `/review/api-versions/${version.id}/approve`, {});
  expect(approved.version.status === 'published', 'the version was not published');
  ok('Publicada');
  await waitFor(async () => (await callGateway()).status === 401, {
    timeoutMs: 60_000,
    what: 'the APISIX route did not appear',
  });
  ok(`La ruta ya existe en APISIX: sin token, ${GATEWAY}${URL_PATH} → 401`);

  step('Descubrir en el catálogo', 'carlos.dev');
  const carlos = await as('carlos.dev');
  const page = await carlos.call('GET', `/catalog/apis?q=${encodeURIComponent(RUN)}`);
  const item = page.items.find((i) => i.api.id === api.id);
  expect(item, 'the API is not in the catalogue');
  ok(
    `"${item.api.name}" de ${item.entity.shortName} · datos personales: ${item.personalFields.join(', ')}`,
  );
  info(`Documentación interactiva: ${WEB}/catalog/${api.id}`);

  step('Crear la aplicación "Validador de subsidios"', 'carlos.dev');
  const programas = carlos.entity('programas-sociales');
  const created = await carlos.call('POST', `/entities/${programas}/applications`, {
    name: `Validador de subsidios (demo ${RUN})`,
    description: 'Verifica requisitos al asignar subsidios.',
    environment: 'production',
    technicalContact: 'dev@programas.demo.rid.example',
  });
  const clientId = created.application.clientId;
  const clientSecret = created.clientSecret;
  ok(`Client ID ${clientId} · secreto ${clientSecret.slice(0, 4)}… (se muestra una sola vez)`);
  await waitFor(
    async () =>
      (await carlos.call('GET', `/entities/${programas}/applications/${created.application.id}`))
        .provisioning === 'ready',
    { timeoutMs: 60_000, what: 'the Keycloak client was not created' },
  );
  const token = await gatewayToken(clientId, clientSecret);
  const noSubscription = await callGateway(token, { 'x-rid-purpose': 'eligibility_check' });
  expect(
    noSubscription.status === 403 && noSubscription.reason === 'no_subscription',
    `expected 403 no_subscription, got ${noSubscription.status} ${noSubscription.reason}`,
  );
  ok('Credenciales listas. Con token pero sin suscripción → 403 no_subscription');

  step('Solicitar acceso con finalidad eligibility_check', 'carlos.dev');
  const subscription = await carlos.call('POST', `/entities/${programas}/subscriptions`, {
    applicationId: created.application.id,
    apiVersionId: version.id,
    purposeCode: 'eligibility_check',
    purposeDetail: 'Verificar afiliación al asignar el subsidio X',
    legalBasisText: 'Ley de protección de datos personales, tratamiento para fines del trámite.',
    validityMonths: 12,
  });
  ok(`Solicitud ${subscription.id} → ${subscription.status}`);

  step('Aprobar con vigencia de 6 meses', 'lucia.datos');
  const lucia = await as('lucia.datos');
  const inbox = await lucia.call(
    'GET',
    `/entities/${salud}/access-requests?status=pending_provider`,
  );
  expect(
    inbox.items.some((s) => s.id === subscription.id),
    'the request is not in the inbox',
  );
  ok('La solicitud está en su bandeja');
  await lucia.call('POST', `/entities/${salud}/access-requests/${subscription.id}/approve`, {
    validityMonths: 6,
    comment: 'Aprobado para el subsidio X.',
  });
  const activatedIn = Date.now();
  await waitFor(
    async () =>
      (await carlos.call('GET', `/entities/${programas}/subscriptions/${subscription.id}`))
        .status === 'active',
    { timeoutMs: 60_000, what: 'the subscription did not become active (OPA bundle)' },
  );
  ok(`Aprobada y activa en el gateway en ${((Date.now() - activatedIn) / 1000).toFixed(1)} s`);

  step('Llamar a la API', 'terminal');
  const requestId = `demo-${RUN}`;
  const allowed = await callGateway(token, {
    'x-rid-purpose': 'eligibility_check',
    'x-rid-end-user': 'funcionario-42',
    'x-request-id': requestId,
  });
  expect(allowed.status === 200, `expected 200, got ${allowed.status} ${allowed.reason}`);
  ok(`200 · ${JSON.stringify(allowed.body)}`);
  const seen = await waitFor(async () => providerSaw(requestId), {
    timeoutMs: 10_000,
    what: 'the provider did not log the request',
  });
  ok('Cabeceras que recibió el proveedor:');
  for (const [name, value] of Object.entries(seen)) info(`  ${name}: ${value}`);
  expect(!('x-rid-end-user' in seen), 'the provider received the official in clear');

  step('Finalidad incorrecta', 'terminal');
  const wrongPurpose = await callGateway(token, {
    'x-rid-purpose': 'benefit_targeting',
    'x-rid-end-user': 'funcionario-42',
  });
  expect(
    wrongPurpose.status === 403 && wrongPurpose.reason === 'purpose_not_allowed',
    `expected 403 purpose_not_allowed, got ${wrongPurpose.status} ${wrongPurpose.reason}`,
  );
  ok(`403 purpose_not_allowed · ${wrongPurpose.body.detail}`);

  step('Revocar', 'lucia.datos');
  await lucia.call('POST', `/entities/${salud}/access-requests/${subscription.id}/revoke`, {
    comment: 'El convenio de intercambio terminó.',
  });
  const revokedAt = Date.now();
  ok('Revocada. Repitiendo la llamada cada segundo…');
  await waitFor(
    async () => {
      const r = await callGateway(token, {
        'x-rid-purpose': 'eligibility_check',
        'x-rid-end-user': 'funcionario-42',
      });
      return r.status === 403 && r.reason === 'no_subscription';
    },
    { timeoutMs: 60_000, what: 'calls kept passing after revocation' },
  );
  const seconds = (Date.now() - revokedAt) / 1000;
  expect(seconds < 60, `revocation took ${seconds} s`);
  ok(`403 no_subscription a los ${seconds.toFixed(1)} s de revocar`);

  step('Auditar', 'marta.regulador');
  const marta = await as('marta.regulador');
  const timeline = await marta.call('GET', `/audit/timeline/subscription/${subscription.id}`);
  for (const e of timeline.items) {
    const who = e.actor.name ?? e.actor.system ?? e.actor.type;
    const change = e.status?.to ? ` · ${e.status.from ?? '—'} → ${e.status.to}` : '';
    info(`  #${e.seq} ${e.action} · ${who}${change}${e.comment ? ` · "${e.comment}"` : ''}`);
  }
  const actions = timeline.items.map((e) => e.action);
  for (const action of [
    'subscription.requested',
    'subscription.approved',
    'subscription.activated',
    'subscription.revoked',
  ]) {
    expect(actions.includes(action), `the timeline lacks ${action}`);
  }
  ok('Línea de tiempo completa');
  const check = await marta.call('GET', '/audit/verify');
  expect(check.valid, `the audit chain is broken at ${JSON.stringify(check.brokenAt)}`);
  ok(
    `Cadena íntegra: ${check.verified} eventos verificados, último hash ${check.lastHash.slice(0, 16)}…`,
  );

  console.log(
    `\n${green(bold('Demo completa en verde'))} ${dim(`(${((Date.now() - started) / 1000).toFixed(0)} s)`)}`,
  );
}

main().catch((error) => {
  const message = error instanceof DemoError ? error.message : (error.stack ?? String(error));
  console.error(`\n${red(bold(`✗ Falló el paso ${stepNo}`))}: ${message}`);
  process.exit(1);
});
