#!/usr/bin/env node
// Automated run of docs/DEMO.md (M1-12) against the local stack, as the five demo characters.
// Prerequisites: `pnpm infra:up` and the portal running (`pnpm dev`). Exits 1 at the first step
// that does not behave as the script promises the audience.
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const {
  API,
  as,
  CITIZEN_CLIENT,
  expect,
  GATEWAY,
  GATEWAY_HTTP,
  KEYCLOAK,
  gatewayFetch,
  gatewayToken,
  clientCertificate,
  login,
  MTLS,
  ScriptError: DemoError,
  tls,
  waitFor,
  WEB,
} = await import('./lib/portal.mjs');

const env = (name, fallback) => process.env[name] ?? fallback;
const RUN = Date.now().toString(36);

// The country of the deployment (DEN_COUNTRY, DEN_CONFIG_DIR): the demo runs in any of them
// (M6-09). Its sector, its purposes and its person document type come from its configuration.
const { loadCountryConfig } = await import(
  pathToFileURL(resolve(root, 'packages/config/dist/index.js')).href
);
const country = loadCountryConfig();
const SECTOR = (country.sectors.find((s) => s.code === 'salud') ?? country.sectors[0]).code;
const PURPOSE = (
  country.purposes.find((p) => p.code === 'eligibility_check') ?? country.purposes[0]
).code;
const OTHER_PURPOSE = country.purposes.find((p) => p.code !== PURPOSE)?.code ?? 'not_allowed';
const PERSON_DOCUMENT_TYPE = country.identifiers.person[0];
/** The provider mock's OpenAPI, with the country's person document type for its data subject. */
const providerOpenapi = () =>
  readFileSync(resolve(root, 'infra/mock-providers/salud/openapi.yaml'), 'utf8').replace(
    /documentType: CC$/gm,
    `documentType: ${PERSON_DOCUMENT_TYPE}`,
  );
const MOCK_CONTAINER = `${env('COMPOSE_PROJECT_NAME', 'den')}-mock-salud-1`;
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

const PERSON = '1000000001';
const URL_PATH = `/salud/${SLUG}/v1/afiliados/${PERSON}`;

async function callGateway(token, headers = {}) {
  // Without a token there is nothing to authenticate: the plain-HTTP listener says whether the
  // route exists (with mTLS, HTTPS without a certificate has no TLS session at all).
  const res = await gatewayFetch(`${token ? GATEWAY : GATEWAY_HTTP}${URL_PATH}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, reason: res.headers.get('x-den-deny-reason'), body };
}

/** What the provider (salud mock) logged for one request: its log entries, by message. */
function providerLog(requestId) {
  const logs = spawnSync('docker', ['logs', '--since', '2m', MOCK_CONTAINER], {
    encoding: 'utf8',
  });
  const entries = {};
  for (const line of `${logs.stdout}${logs.stderr}`.split('\n')) {
    if (!line.includes(requestId)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.den?.['x-request-id'] === requestId) entries[entry.msg] = entry;
    } catch {
      // not a JSON log line
    }
  }
  return entries;
}

/** X-DEN-* headers the provider logged for one request. */
const providerSaw = (requestId) => providerLog(requestId)['request received']?.den;

// --- Script ------------------------------------------------------------------------------------

async function preflight() {
  const checks = [
    ['portal API', `${API}/health`],
    ['Keycloak', `${KEYCLOAK}/realms/den-portal`],
    ['gateway', `${GATEWAY_HTTP}/`],
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
    sector: SECTOR,
    tags: ['afiliacion'],
    classification: 'personal',
    ownerContact: 'apis@salud.demo.den.example',
  });
  const version = await pedro.call('POST', `/entities/${salud}/apis/${api.id}/versions`, {
    version: '1.0',
    openapi: providerOpenapi(),
    upstream: { type: 'node', servicePath: '/salud' },
    allowedPurposes: [PURPOSE],
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
  // The validations at submission (M4-06) must pass before the operator approves.
  await waitFor(
    async () =>
      (await ana.call('GET', `/review/api-versions/${version.id}`)).version.validation?.status ===
      'passed',
    { timeoutMs: 120_000, what: 'the automatic validations did not pass' },
  );
  ok('Validaciones automáticas superadas (healthcheck a través del gateway y prueba de contrato)');
  const review = await ana.call('GET', `/review/api-versions/${version.id}`);
  info(`Datos que expone: ${review.version.exposedFields.map((f) => f.name).join(', ')}`);
  const approved = await ana.call('POST', `/review/api-versions/${version.id}/approve`, {});
  expect(approved.version.status === 'published', 'the version was not published');
  ok('Publicada');
  await waitFor(async () => (await callGateway()).status === 401, {
    timeoutMs: 60_000,
    what: 'the APISIX route did not appear',
  });
  ok(`La ruta ya existe en APISIX: sin token, ${GATEWAY_HTTP}${URL_PATH} → 401`);

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
    technicalContact: 'dev@programas.demo.den.example',
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
  if (MTLS) {
    const leaf = await clientCertificate(carlos, programas, created.application.id, clientId);
    ok(`Certificado de cliente ${leaf.subject} emitido por la CA de la red, vence ${leaf.validTo}`);
  }
  const token = await gatewayToken(clientId, clientSecret);
  if (MTLS) {
    const cnf = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).cnf;
    const thumbprint = createHash('sha256')
      .update(new X509Certificate(tls.client.cert).raw)
      .digest('base64url');
    expect(cnf?.['x5t#S256'] === thumbprint, 'the token is not bound to the client certificate');
    ok(
      `Token pedido al gateway (${GATEWAY}/oauth/token), ligado al certificado: x5t#S256 ${thumbprint.slice(0, 12)}…`,
    );
  }
  // A just-issued certificate reaches OPA with the next bundle (10-20 s): until then the call is
  // denied as certificate_revoked.
  const noSubscription = await waitFor(
    async () => {
      const r = await callGateway(token, { 'x-den-purpose': PURPOSE });
      return r.reason === 'certificate_revoked' ? undefined : r;
    },
    { timeoutMs: 60_000, what: 'the gateway did not learn the new client certificate' },
  );
  expect(
    noSubscription.status === 403 && noSubscription.reason === 'no_subscription',
    `expected 403 no_subscription, got ${noSubscription.status} ${noSubscription.reason}`,
  );
  ok('Credenciales listas. Con token pero sin suscripción → 403 no_subscription');

  step(`Solicitar acceso con finalidad ${PURPOSE}`, 'carlos.dev');
  const subscription = await carlos.call('POST', `/entities/${programas}/subscriptions`, {
    applicationId: created.application.id,
    apiVersionId: version.id,
    purposeCode: PURPOSE,
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
    'x-den-purpose': PURPOSE,
    'x-den-end-user': 'funcionario-42',
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
  expect(!('x-den-end-user' in seen), 'the provider received the official in clear');
  if (country.features.gatewayAssertion) {
    // The gateway's signed assertion (ADR-0024, M6-10): the provider verified it with the JWKS.
    const checked = await waitFor(async () => providerLog(requestId)['gateway assertion'], {
      timeoutMs: 10_000,
      what: 'the provider did not check the gateway assertion',
    });
    expect(
      checked.assertion === 'verified',
      `the provider could not verify the gateway assertion: ${checked.assertion}`,
    );
    ok('El proveedor verificó la aserción firmada del gateway (X-DEN-Assertion) con el JWKS');
  }

  step('Finalidad incorrecta', 'terminal');
  const wrongPurpose = await callGateway(token, {
    'x-den-purpose': OTHER_PURPOSE,
    'x-den-end-user': 'funcionario-42',
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
        'x-den-purpose': PURPOSE,
        'x-den-end-user': 'funcionario-42',
      });
      return r.status === 403 && r.reason === 'no_subscription';
    },
    { timeoutMs: 60_000, what: 'calls kept passing after revocation' },
  );
  const seconds = (Date.now() - revokedAt) / 1000;
  expect(seconds < 60, `revocation took ${seconds} s`);
  ok(`403 no_subscription a los ${seconds.toFixed(1)} s de revocar`);

  if (MTLS) {
    // M3 closing criterion: a revoked certificate stops working within 60 s, whatever the token.
    step('Revocar el certificado de la aplicación', 'carlos.dev');
    await carlos.call(
      'POST',
      `/entities/${programas}/applications/${created.application.id}/credentials/${tls.credentialId}/revoke`,
      { reason: 'La clave privada quedó expuesta.' },
    );
    const certificateRevokedAt = Date.now();
    await waitFor(
      async () =>
        (await callGateway(token, { 'x-den-purpose': PURPOSE })).reason === 'certificate_revoked',
      { timeoutMs: 60_000, what: 'the revoked certificate kept working' },
    );
    const after = (Date.now() - certificateRevokedAt) / 1000;
    expect(after < 60, `certificate revocation took ${after} s`);
    ok(`403 certificate_revoked a los ${after.toFixed(1)} s de revocar el certificado`);
  }

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

  step('Ver quién consultó mis datos', 'ciudadana.demo');
  const citizenToken = await login('ciudadana.demo', CITIZEN_CLIENT);
  const asCitizen = async (path) => {
    const res = await fetch(`${API}/data-subjects/me${path}`, {
      headers: { authorization: `Bearer ${citizenToken}` },
    });
    expect(res.ok, `ciudadana.demo: GET ${path} -> ${res.status}`);
    return res.json();
  };
  const demoApi = `Consulta de afiliación (demo ${RUN})`;
  const mine = await waitFor(
    async () =>
      (await asCitizen('/accesses?limit=100')).items.find(
        (a) => a.api?.name === demoApi && a.status === 200,
      ),
    { timeoutMs: 30_000, what: 'the citizen does not see the call of step 7' },
  );
  ok(
    `${mine.consumer.entity?.shortName} consultó ${mine.api.name} para "${mine.purpose.name?.es ?? mine.purpose.name?.en ?? mine.purpose.code}"`,
  );
  info(`  funcionario (referencia): ${mine.officialRef?.slice(0, 16)}…`);
  const receipt = await waitFor(
    async () => {
      const sealed = (await asCitizen('/accesses?limit=100')).items.find(
        (a) => a.id === mine.id && a.sealed,
      );
      if (!sealed) return undefined;
      const r = await asCitizen(`/accesses/${mine.id}/receipt`);
      return r.timestamp ? r : undefined;
    },
    { timeoutMs: 90_000, everyMs: 3_000, what: 'the consultation was not sealed and stamped' },
  );
  const verifierPath = resolve(root, 'packages/transparency-verifier/dist/index.js');
  expect(
    existsSync(verifierPath),
    'build the verifier first: pnpm --filter @den/transparency-verifier build',
  );
  const { verifyReceipt, certificatesInPem } = await import(pathToFileURL(verifierPath).href);
  const jwks = await (await fetch(`${API}/transparency/jwks`)).json();
  const tsaRootUrl = env(
    'CITIZEN_APP_TSA_ROOT_URL',
    `${env('DEN_TSA_URL', 'http://localhost:3004')}/api/v1/timestamp/certchain`,
  );
  const tsaChain = await (await fetch(tsaRootUrl)).text();
  const result = await verifyReceipt(receipt, { jwks, tsaRoots: certificatesInPem(tsaChain) });
  expect(result.valid, `the receipt does not verify: ${result.errors.join('; ')}`);
  ok(
    `Comprobante válido: firma del operador, inclusión en el lote ${result.checkpoint.seq} y sello de tiempo (${result.stampedAt})`,
  );
  info(`  App ciudadana de referencia: ${env('DEN_CITIZEN_APP_URL', 'http://localhost:3100')}`);

  console.log(
    `\n${green(bold('Demo completa en verde'))} ${dim(`(${((Date.now() - started) / 1000).toFixed(0)} s)`)}`,
  );
}

main().catch((error) => {
  const message = error instanceof DemoError ? error.message : (error.stack ?? String(error));
  console.error(`\n${red(bold(`✗ Falló el paso ${stepNo}`))}: ${message}`);
  process.exit(1);
});
