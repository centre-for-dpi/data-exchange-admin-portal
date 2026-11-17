// Sessions in the portal and calls through the gateway, as the scripts' characters (demo,
// load test). Each script loads the repo's .env before importing this module.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DEMO_TOTP_SECRET, totp } from '../totp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const env = (name, fallback) => process.env[name] ?? fallback;
export const API = `${env('DEN_API_URL', 'http://localhost:4000')}/api/v1`;
export const KEYCLOAK = env('KEYCLOAK_URL', 'http://localhost:8080');
export const GATEWAY = env('DEN_GATEWAY_PUBLIC_URL', 'https://localhost:9443');
// The plain-HTTP listener of the local gateway: only for "does the route exist yet?" (no token).
export const GATEWAY_HTTP = env('DEN_GATEWAY_HTTP_URL', 'http://localhost:9080');
// With mTLS (M3-10) the gateway is HTTPS and every call presents the application's certificate.
export const MTLS = GATEWAY.startsWith('https://');
export const WEB = env('DEN_WEB_URL', 'http://localhost:3000');
const PASSWORD = env('DEN_DEMO_USER_PASSWORD', 'den-demo-password');
const TOTP_SECRET = env('DEN_DEMO_TOTP_SECRET', DEFAULT_DEMO_TOTP_SECRET);

/** A step that did not behave as the script promises. */
export class ScriptError extends Error {}
export function expect(condition, message) {
  if (!condition) throw new ScriptError(message);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repeats `probe` every `everyMs` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor(probe, { timeoutMs, everyMs = 1_000, what }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new ScriptError(`Timed out after ${timeoutMs / 1000} s: ${what}`);
    await sleep(everyMs);
  }
}

// --- Keycloak login (Authorization Code + PKCE, like the web app) ------------------------------

const PORTAL_CLIENT = {
  realm: 'den-portal',
  clientId: env('DEN_PORTAL_WEB_CLIENT_ID', 'den-portal-web'),
  secret: env('DEN_PORTAL_WEB_CLIENT_SECRET', ''),
  redirectUri: `${WEB}/api/auth/callback/keycloak`,
};
/** The reference citizen folder in the (simulated) national identity (MT-05, MT-07). */
export const CITIZEN_CLIENT = {
  realm: 'den-citizens',
  clientId: 'citizen-app',
  secret: env('DEN_CITIZEN_APP_CLIENT_SECRET', ''),
  redirectUri: `${env('DEN_CITIZEN_APP_URL', 'http://localhost:3100')}/auth/callback`,
};

/** Seed users with a critical role: their realm entry has a one-time code (M3-08). */
const MFA_USERS = new Set(
  JSON.parse(readFileSync(resolve(root, 'infra/keycloak/den-portal-realm.json'), 'utf8'))
    .users.filter((u) => u.credentials?.some((c) => c.type === 'otp'))
    .map((u) => u.username),
);
/** Codes already sent per user: Keycloak accepts each code once. */
const usedCodes = new Map();

/**
 * The one-time code step (M3-08). Keycloak accepts the code of this 30 s period and of the ones
 * on either side; a code is good only once, so a character signing in again tries another.
 */
async function submitOtp(username, html, post) {
  const used = usedCodes.get(username) ?? new Set();
  usedCodes.set(username, used);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const action = /<form[^>]+id="kc-otp-login-form"[^>]+action="([^"]+)"/.exec(html)?.[1];
    expect(action, `Keycloak one-time code form not found for ${username}`);
    const code = [0, 30_000, -30_000]
      .map((d) => totp(TOTP_SECRET, Date.now() + d))
      .find((c) => !used.has(c));
    if (!code) {
      await sleep(30_000 - (Date.now() % 30_000) + 500);
      continue;
    }
    used.add(code);
    const res = await post(action, { otp: code });
    if (res.headers.get('location')) return res;
    html = await res.text();
  }
  throw new ScriptError(
    `Keycloak refused the one-time codes of ${username} (is DEN_DEMO_TOTP_SECRET right?)`,
  );
}

export async function login(username, client = PORTAL_CLIENT) {
  const realm = `${KEYCLOAK}/realms/${client.realm}/protocol/openid-connect`;
  const redirectUri = client.redirectUri;
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: client.clientId,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  // A critical role needs the second factor: ask for it, as the web does after /me (ADR-0021).
  const mfa = client === PORTAL_CLIENT && MFA_USERS.has(username);
  if (mfa) params.set('acr_values', 'mfa');
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
  const post = async (target, body) => {
    const res = await fetch(target.replaceAll('&amp;', '&'), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: new URLSearchParams(body),
    });
    keep(res);
    return res;
  };
  let submitted = await post(action, { username, password: PASSWORD, credentialId: '' });
  if (mfa && !submitted.headers.get('location')) {
    submitted = await submitOtp(username, await submitted.text(), post);
  }
  const code = new URL(submitted.headers.get('location') ?? 'http://x/').searchParams.get('code');
  expect(code, `Login failed for ${username} (is DEN_DEMO_USER_PASSWORD right?)`);
  const { clientId, secret } = client;
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
export async function as(username) {
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

/** The application's key and certificate, once carlos has one (M3-10), and the network root. */
export const tls = { client: undefined, ca: undefined };

/** fetch() for the gateway: over HTTPS, trusting the network CA and with the client certificate. */
export async function gatewayFetch(url, { method = 'GET', headers = {}, body } = {}) {
  // Only the gateway's own name uses the network CA (and the client certificate); other HTTPS
  // URLs, such as a proxy's public /gw, have ordinary certificates.
  if (!url.startsWith(GATEWAY) || !GATEWAY.startsWith('https://')) {
    return fetch(url, { method, headers, body });
  }
  tls.ca ??= await (await fetch(`${API}/pki/ca`)).text();
  const target = new URL(url);
  return new Promise((resolveCall, reject) => {
    const req = httpsRequest(
      {
        host: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        ca: tls.ca,
        agent: false,
        ...(tls.client ?? {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            for (const one of [v].flat()) if (one !== undefined) h.append(k, one);
          }
          resolveCall(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: h }));
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * carlos's client certificate (M3-10): the key and the CSR are made on "his server" (openssl,
 * here a temporary folder); the portal has the network CA sign it. The key never leaves.
 */
export async function clientCertificate(carlos, entityId, applicationId, clientId) {
  const dir = mkdtempSync(join(tmpdir(), 'den-script-'));
  try {
    const run = spawnSync(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        join(dir, 'app.key'),
        '-out',
        join(dir, 'app.csr'),
        '-subj',
        `/CN=${clientId}`,
      ],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    expect(run.status === 0, `openssl could not make the CSR: ${run.stderr || run.error}`);
    const issued = await carlos.call(
      'POST',
      `/entities/${entityId}/applications/${applicationId}/certificates`,
      { csr: readFileSync(join(dir, 'app.csr'), 'utf8') },
    );
    tls.client = { cert: issued.certificatePem, key: readFileSync(join(dir, 'app.key'), 'utf8') };
    tls.credentialId = issued.credential.id;
    return new X509Certificate(issued.certificatePem);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** client_credentials at the gateway's token route: with mTLS, bound to the certificate. */
export async function gatewayToken(clientId, clientSecret) {
  const res = await gatewayFetch(`${GATEWAY}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  expect(res.ok, `client_credentials token failed: ${res.status} ${await res.clone().text()}`);
  return (await res.json()).access_token;
}

/** A person the provider's test service has (infra/mock-providers: FIRST_ID). */
export const TEST_PERSON = '1000000001';

/**
 * An application that calls a published API through the gateway, as in docs/DEMO.md: pedro
 * publishes an API of salud (its test service), ana approves it, carlos creates the application
 * with its certificate (with mTLS) and asks for access, lucia approves it. Returns once a call goes
 * through. Load and resilience tests (M6-03, M6-04).
 */
export async function callingApplication({ slug, purpose, rateLimitPerMinute, log = () => {} }) {
  const pedro = await as('pedro.publicador');
  const salud = pedro.entity('salud');
  const api = await pedro.call('POST', `/entities/${salud}/apis`, {
    slug,
    name: `Prueba ${slug}`,
    summary: purpose,
    description: 'Datos sintéticos.',
    sector: 'salud',
    tags: ['prueba'],
    classification: 'personal',
    ownerContact: 'apis@salud.demo.den.example',
  });
  const version = await pedro.call('POST', `/entities/${salud}/apis/${api.id}/versions`, {
    version: '1.0',
    openapi: readFileSync(resolve(root, 'infra/mock-providers/salud/openapi.yaml'), 'utf8'),
    upstream: { type: 'node', servicePath: '/salud' },
    allowedPurposes: ['eligibility_check'],
    exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
  });
  await pedro.call('POST', `/entities/${salud}/apis/${api.id}/versions/${version.id}/submit`);
  const ana = await as('ana.operadora');
  await waitFor(
    async () =>
      (await ana.call('GET', `/review/api-versions/${version.id}`)).version.validation?.status ===
      'passed',
    { timeoutMs: 180_000, what: 'the automatic validations did not pass' },
  );
  await ana.call('POST', `/review/api-versions/${version.id}/approve`, {});
  const basePath = `/salud/${slug}/v1`;
  log(`  API publicada: ${basePath}`);

  const carlos = await as('carlos.dev');
  const programas = carlos.entity('programas-sociales');
  const created = await carlos.call('POST', `/entities/${programas}/applications`, {
    name: `Prueba ${slug}`,
    description: purpose,
    environment: 'production',
    technicalContact: 'dev@programas.demo.den.example',
  });
  const app = created.application;
  await waitFor(
    async () =>
      (await carlos.call('GET', `/entities/${programas}/applications/${app.id}`)).provisioning ===
      'ready',
    { timeoutMs: 120_000, what: 'the Keycloak client was not created' },
  );
  if (MTLS) await clientCertificate(carlos, programas, app.id, app.clientId);
  const subscription = await carlos.call('POST', `/entities/${programas}/subscriptions`, {
    applicationId: app.id,
    apiVersionId: version.id,
    purposeCode: 'eligibility_check',
    purposeDetail: purpose,
    legalBasisText: 'Datos sintéticos de la prueba.',
    validityMonths: 12,
    ...(rateLimitPerMinute ? { requestedRateLimit: rateLimitPerMinute } : {}),
  });
  const lucia = await as('lucia.datos');
  await lucia.call('POST', `/entities/${salud}/access-requests/${subscription.id}/approve`, {
    validityMonths: 6,
    comment: 'Prueba.',
  });
  await waitFor(
    async () =>
      (await carlos.call('GET', `/entities/${programas}/subscriptions/${subscription.id}`))
        .status === 'active',
    { timeoutMs: 120_000, what: 'the subscription did not become active' },
  );
  // The certificate and the subscription reach OPA with the bundle: until a call goes through.
  const token = await gatewayToken(app.clientId, created.clientSecret);
  const path = `${basePath}/afiliados/{n}`;
  await waitFor(
    async () =>
      (
        await gatewayFetch(`${GATEWAY}${path.replace('{n}', TEST_PERSON)}`, {
          headers: {
            authorization: `Bearer ${token}`,
            'x-den-purpose': 'eligibility_check',
            'x-den-end-user': 'funcionario-prueba',
          },
        })
      ).status === 200,
    { timeoutMs: 120_000, what: 'the first call through the gateway did not succeed' },
  );
  log(`  Aplicación ${app.clientId} con certificado y suscripción activa`);
  return {
    clientId: app.clientId,
    clientSecret: created.clientSecret,
    path,
    versionId: version.id,
    subscriptionId: subscription.id,
    consumer: { actor: carlos, entityId: programas, applicationId: app.id },
    provider: { actor: lucia, entityId: salud },
  };
}
