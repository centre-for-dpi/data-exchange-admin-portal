#!/usr/bin/env node
// SPIKE S-4: Keycloak client authentication with tls_client_auth and certificate-bound access
// tokens (RFC 8705) in client_credentials. Run with the stack up (it uses step-ca's CLI):
//   node docs/spikes/S-4/run-spike.mjs
// It starts throwaway Keycloak containers (same image as the stack, never the shared one), checks
// two set-ups (TLS straight to Keycloak, and the certificate forwarded by a proxy in a header)
// and removes everything at the end.
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMAGE = 'quay.io/keycloak/keycloak:26.8.0';
const NAME = 'rid-spike-s4-kc';
const HTTPS_PORT = 8449;
const HTTP_PORT = 8089;
const DIR = '/tmp/spike-s4';
const REALM = 'spike-s4';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const step = (...args) => {
  const res = docker('exec', 'rid-step-ca-1', 'step', ...args);
  if (res.status !== 0) throw new Error(`step ${args.join(' ')}: ${res.stderr}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const x5tS256 = (pem) =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('base64url');
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

// --- Certificates ---------------------------------------------------------------------------

function certificates() {
  docker('exec', 'rid-step-ca-1', 'rm', '-rf', DIR);
  docker('exec', 'rid-step-ca-1', 'mkdir', '-p', DIR);
  const common = ['--no-password', '--insecure', '--force'];
  step(
    'certificate',
    'create',
    'Spike S-4 CA',
    `${DIR}/ca.crt`,
    `${DIR}/ca.key`,
    '--profile',
    'root-ca',
    ...common,
  );
  const leaf = (name, file, extra = []) =>
    step(
      'certificate',
      'create',
      name,
      `${DIR}/${file}.crt`,
      `${DIR}/${file}.key`,
      '--profile',
      'leaf',
      '--ca',
      `${DIR}/ca.crt`,
      '--ca-key',
      `${DIR}/ca.key`,
      '--not-after',
      '1h',
      ...common,
      ...extra,
    );
  leaf('localhost', 'server', ['--san', 'localhost']);
  leaf('rid-app-s4', 'app');
  leaf('rid-app-other', 'other');
  const read = (f) => docker('exec', 'rid-step-ca-1', 'cat', `${DIR}/${f}`).stdout;
  const files = Object.fromEntries(
    ['ca.crt', 'server.crt', 'server.key', 'app.crt', 'app.key', 'other.crt', 'other.key'].map(
      (f) => [f, read(f)],
    ),
  );
  docker('exec', 'rid-step-ca-1', 'rm', '-rf', DIR);
  return files;
}

// --- Throwaway Keycloak ---------------------------------------------------------------------

async function startKeycloak(pki, extraArgs) {
  docker('rm', '-f', NAME);
  const created = docker(
    'create',
    '--name',
    NAME,
    '-p',
    `127.0.0.1:${HTTPS_PORT}:8443`,
    '-p',
    `127.0.0.1:${HTTP_PORT}:8080`,
    '-e',
    'KC_BOOTSTRAP_ADMIN_USERNAME=admin',
    '-e',
    'KC_BOOTSTRAP_ADMIN_PASSWORD=spike-only',
    IMAGE,
    'start-dev',
    '--http-enabled=true',
    '--https-certificate-file=/opt/keycloak/conf/spike/server.crt',
    '--https-certificate-key-file=/opt/keycloak/conf/spike/server.key',
    '--truststore-paths=/opt/keycloak/conf/spike/ca.crt',
    ...extraArgs,
  );
  if (created.status !== 0) throw new Error(created.stderr);
  const local = mkdtempSync(join(tmpdir(), 'rid-spike-s4-'));
  for (const f of ['ca.crt', 'server.crt', 'server.key']) {
    writeFileSync(join(local, f), pki[f], { mode: 0o644 });
  }
  const copied = docker('cp', local, `${NAME}:/opt/keycloak/conf/spike`);
  rmSync(local, { recursive: true, force: true });
  if (copied.status !== 0) throw new Error(copied.stderr);
  docker('start', NAME);
  for (let i = 0; i < 90; i++) {
    const ok = await fetch(`http://localhost:${HTTP_PORT}/realms/master`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await sleep(2_000);
  }
  throw new Error(`Keycloak did not start: ${docker('logs', '--tail', '30', NAME).stdout}`);
}

async function adminToken() {
  const res = await fetch(
    `http://localhost:${HTTP_PORT}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=password&client_id=admin-cli&username=admin&password=spike-only',
    },
  );
  return (await res.json()).access_token;
}

async function setUpRealm() {
  const token = await adminToken();
  const api = (path, body) =>
    fetch(`http://localhost:${HTTP_PORT}/admin${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    });
  await api('/realms', { realm: REALM, enabled: true });
  const base = {
    protocol: 'openid-connect',
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
  };
  // tls_client_auth (RFC 8705 §2.1): the client is the certificate whose subject DN matches.
  await api(`/realms/${REALM}/clients`, {
    ...base,
    clientId: 'rid-app-s4',
    clientAuthenticatorType: 'client-x509',
    attributes: {
      'x509.subjectdn': 'CN=rid-app-s4',
      // Pin the issuing CA too (Keycloak warns that a subject alone is deprecated).
      'x509.casubjectdn': 'CN=Spike S-4 CA',
      'x509.allow.regex.pattern.comparison': 'false',
      'tls.client.certificate.bound.access.tokens': 'true',
    },
  });
  // A secret for authentication, the certificate only to bind the token (RFC 8705 §3).
  await api(`/realms/${REALM}/clients`, {
    ...base,
    clientId: 'rid-app-s4-secret',
    clientAuthenticatorType: 'client-secret',
    secret: 'spike-secret',
    attributes: { 'tls.client.certificate.bound.access.tokens': 'true' },
  });
}

// --- Token requests -------------------------------------------------------------------------

function tokenRequest({ tls = true, client, cert, secret, headers = {} }) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: client });
  if (secret) body.set('client_secret', secret);
  return new Promise((done) => {
    const options = {
      host: 'localhost',
      port: tls ? HTTPS_PORT : HTTP_PORT,
      path: `/realms/${REALM}/protocol/openid-connect/token`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      ...(tls ? { ca: PKI['ca.crt'], agent: false } : {}),
      ...(tls && cert ? { cert: PKI[`${cert}.crt`], key: PKI[`${cert}.key`] } : {}),
    };
    const send = tls
      ? request
      : (opts, cb) => import('node:http').then(({ request: plain }) => plain(opts, cb));
    Promise.resolve(
      send(options, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          const json = JSON.parse(text || '{}');
          done({
            status: res.statusCode,
            error: json.error,
            cnf: json.access_token ? claimsOf(json.access_token).cnf?.['x5t#S256'] : undefined,
          });
        });
      }),
    ).then((req) => {
      req.on('error', (e) => done({ status: 'error', error: e.code ?? e.message }));
      req.end(body.toString());
    });
  });
}

const results = [];
const check = (name, got, expect) => {
  const ok = Object.entries(expect).every(([k, v]) => got[k] === v);
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}`);
};

let PKI;

async function main() {
  PKI = certificates();
  const app = x5tS256(PKI['app.crt']);
  const other = x5tS256(PKI['other.crt']);
  try {
    // --- A: TLS terminates at Keycloak, which asks for (but does not demand) a certificate.
    console.log('A. TLS straight to Keycloak (--https-client-auth=request)');
    await startKeycloak(PKI, ['--https-client-auth=request']);
    await setUpRealm();
    check(
      'tls_client_auth: the right certificate gets a token bound to it',
      await tokenRequest({ client: 'rid-app-s4', cert: 'app' }),
      { status: 200, cnf: app },
    );
    check(
      'tls_client_auth: a certificate with another subject is not the client',
      await tokenRequest({ client: 'rid-app-s4', cert: 'other' }),
      { status: 401, error: 'invalid_client' },
    );
    check(
      'tls_client_auth: without a certificate there is no token',
      await tokenRequest({ client: 'rid-app-s4' }),
      { status: 401, error: 'invalid_client' },
    );
    check(
      'secret + bound tokens: the token is bound to whatever certificate was presented',
      await tokenRequest({ client: 'rid-app-s4-secret', secret: 'spike-secret', cert: 'other' }),
      { status: 200, cnf: other },
    );
    check(
      'secret + bound tokens: without a certificate the request is refused',
      await tokenRequest({ client: 'rid-app-s4-secret', secret: 'spike-secret' }),
      { status: 400, error: 'invalid_request' },
    );

    // --- B: a proxy terminates TLS and forwards the certificate in a header (nginx provider:
    // URL-encoded PEM, as nginx's $ssl_client_escaped_cert).
    console.log('B. Certificate forwarded by a proxy in a header');
    await startKeycloak(PKI, [
      '--https-client-auth=none',
      '--spi-x509cert-lookup--provider=nginx',
      '--spi-x509cert-lookup--nginx--ssl-client-cert=SSL_CLIENT_CERT',
      '--spi-x509cert-lookup--nginx--trust-proxy-verification=true',
      ...(process.env.SPIKE_DEBUG
        ? ['--log-level=INFO,org.keycloak.services.x509:debug,org.keycloak.authentication:debug']
        : []),
    ]);
    await setUpRealm();
    // trust-proxy-verification: Keycloak relies on the proxy having verified the chain, which the
    // proxy states in ssl-client-verify (nginx's $ssl_client_verify).
    const forwarded = (cert) => ({
      SSL_CLIENT_CERT: encodeURIComponent(PKI[`${cert}.crt`]),
      'ssl-client-verify': 'SUCCESS',
    });
    check(
      'the forwarded certificate authenticates the client and binds the token',
      await tokenRequest({ tls: false, client: 'rid-app-s4', headers: forwarded('app') }),
      { status: 200, cnf: app },
    );
    check(
      'Keycloak trusts the header: anyone who reaches it directly can present any certificate',
      await tokenRequest({
        tls: false,
        client: 'rid-app-s4-secret',
        secret: 'spike-secret',
        headers: forwarded('other'),
      }),
      { status: 200, cnf: other },
    );
  } finally {
    if (process.env.SPIKE_DEBUG) {
      const logs = docker('logs', NAME);
      console.log(
        `${logs.stdout}${logs.stderr}`
          .split(/\r?\n/)
          .filter((l) => /x509|certif|client auth|nginx/i.test(l))
          .slice(-25)
          .join('\n'),
      );
    }
    docker('rm', '-f', NAME);
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks as expected`);
  process.exitCode = failed ? 1 : 0;
}

await main();
