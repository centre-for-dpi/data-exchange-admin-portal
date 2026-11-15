#!/usr/bin/env node
// SPIKE S-3: client mTLS at APISIX, the certificate's SHA-256 thumbprint, its comparison with
// the token's cnf["x5t#S256"] (RFC 8705) and revocation in OPA. Run with the stack up:
//   node docs/spikes/S-3/run-spike.mjs
// It creates temporary objects (certificates inside the step-ca container, an APISIX SSL object
// and route, an OPA policy and data document) and removes them at the end.
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const ADMIN = `http://localhost:${process.env.APISIX_ADMIN_PORT ?? 9180}/apisix/admin`;
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
const TLS_PORT = Number(process.env.APISIX_HTTPS_PORT ?? 9443);
const SNI = 'gw.spike-s3.localhost';
const ID = 'rid-spike-s3';
const DIR = '/tmp/spike-s3';
const HEADER = 'X-RID-Client-Cert-S256';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const step = (...args) => {
  const res = docker('exec', 'rid-step-ca-1', 'step', ...args);
  if (res.status !== 0) throw new Error(`step ${args.join(' ')}: ${res.stderr}`);
};
const read = (file) => docker('exec', 'rid-step-ca-1', 'cat', `${DIR}/${file}`).stdout;
const admin = (path, init = {}) =>
  fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'x-api-key': process.env.APISIX_ADMIN_KEY, 'content-type': 'application/json' },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** RFC 8705 §3.1: base64url (no padding) of the SHA-256 of the certificate's DER. */
const x5tS256 = (pem) =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('base64url');

/** An unsigned token: the spike's policy only decodes it (signature checks are not the question). */
const token = (claims) =>
  [
    { alg: 'none', typ: 'JWT' },
    { azp: 'spike-app', ...claims },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')
    .concat('.');

// --- 1. Certificates (inside the step-ca container, nothing on the host) -------------------------

function certificates() {
  docker('exec', 'rid-step-ca-1', 'rm', '-rf', DIR);
  docker('exec', 'rid-step-ca-1', 'mkdir', '-p', DIR);
  const common = ['--no-password', '--insecure', '--force'];
  step(
    'certificate',
    'create',
    'Spike S-3 CA',
    `${DIR}/ca.crt`,
    `${DIR}/ca.key`,
    '--profile',
    'root-ca',
    ...common,
  );
  step(
    'certificate',
    'create',
    'Intruder CA',
    `${DIR}/bad-ca.crt`,
    `${DIR}/bad-ca.key`,
    '--profile',
    'root-ca',
    ...common,
  );
  const leaf = (name, file, ca = 'ca') =>
    step(
      'certificate',
      'create',
      name,
      `${DIR}/${file}.crt`,
      `${DIR}/${file}.key`,
      '--profile',
      'leaf',
      '--ca',
      `${DIR}/${ca}.crt`,
      '--ca-key',
      `${DIR}/${ca}.key`,
      '--not-after',
      '1h',
      ...common,
      ...(file === 'server' ? ['--san', SNI] : []),
    );
  leaf(SNI, 'server');
  leaf('rid-app-a', 'app-a');
  leaf('rid-app-b', 'app-b');
  leaf('rid-app-a', 'intruder', 'bad-ca'); // same subject as app-a, issued by another CA
  const pem = (f) => read(f);
  return {
    ca: pem('ca.crt'),
    server: { cert: pem('server.crt'), key: pem('server.key') },
    a: { cert: pem('app-a.crt'), key: pem('app-a.key') },
    b: { cert: pem('app-b.crt'), key: pem('app-b.key') },
    intruder: { cert: pem('intruder.crt'), key: pem('intruder.key') },
  };
}

// --- 2. Gateway and policy --------------------------------------------------------------------

// Rewrite phase, before openid-connect would validate the token and before opa (access phase):
// drop any thumbprint the client sends, then set the one of the certificate verified in the TLS
// handshake. ngx.var.ssl_client_fingerprint is SHA-1 of the DER (not usable for x5t#S256).
const THUMBPRINT_LUA = `return function(conf, ctx)
  local core = require("apisix.core")
  local ngx_ssl = require("ngx.ssl")
  local resty_sha256 = require("resty.sha256")
  core.request.set_header(ctx, "${HEADER}", nil)
  local pem = ngx.var.ssl_client_raw_cert
  if ngx.var.ssl_client_verify ~= "SUCCESS" or not pem then return end
  local der = ngx_ssl.cert_pem_to_der(pem)
  if not der then return end
  local sha = resty_sha256:new()
  sha:update(der)
  local b64 = ngx.encode_base64(sha:final())
  b64 = string.gsub(b64, "[+/=]", { ["+"] = "-", ["/"] = "_", ["="] = "" })
  core.request.set_header(ctx, "${HEADER}", b64)
end`;

const POLICY = `package spikes3

import rego.v1

header(name) := v if {
	v := input.request.headers[name]
	is_string(v)
}

claims := payload if {
	parts := split(header("authorization"), " ")
	[_, payload, _] := io.jwt.decode(parts[1])
}

thumbprint := header("${HEADER.toLowerCase()}")

bound := claims.cnf["x5t#S256"]

reason := "no_client_cert" if {
	not thumbprint
} else := "token_not_bound" if {
	not bound
} else := "cert_mismatch" if {
	bound != thumbprint
} else := "cert_revoked" if {
	thumbprint in data.spikes3.revoked
}

default allow := false

allow if not reason

headers := {"X-RID-Deny-Reason": reason} if reason


status_code := 403
`;

async function setUp(pki) {
  const ssl = await admin(`/ssls/${ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      snis: [SNI],
      cert: pki.server.cert,
      key: pki.server.key,
      client: { ca: pki.ca, depth: 1 },
    }),
  });
  if (!ssl.ok) throw new Error(`ssl: ${ssl.status} ${await ssl.text()}`);
  const policy = await fetch(`${OPA}/v1/policies/spikes3`, { method: 'PUT', body: POLICY });
  if (!policy.ok) throw new Error(`policy: ${policy.status} ${await policy.text()}`);
  await fetch(`${OPA}/v1/data/spikes3`, { method: 'PUT', body: JSON.stringify({ revoked: [] }) });
  const route = await admin(`/routes/${ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      host: SNI,
      uri: '/spike-s3/*',
      methods: ['GET'],
      upstream: { type: 'roundrobin', scheme: 'http', nodes: { 'mock-salud:8000': 1 } },
      plugins: {
        'serverless-pre-function': { phase: 'rewrite', functions: [THUMBPRINT_LUA] },
        'proxy-rewrite': { regex_uri: ['^/spike-s3/(.*)$', '/$1'] },
        // The thumbprint stays a gateway-only header: listed here and never returned by the
        // policy, so it is removed before the upstream (SPIKE S-1).
        opa: { host: 'http://opa:8181', policy: 'spikes3', send_headers_upstream: [HEADER] },
        // Debug only: echo what the gateway computed (nginx variables) back to the caller.
        'response-rewrite': {
          headers: {
            set: {
              'X-RID-Debug-Thumbprint': '$http_x_rid_client_cert_s256',
              'X-RID-Debug-Sha1': '$ssl_client_fingerprint',
            },
          },
        },
      },
    }),
  });
  if (!route.ok) throw new Error(`route: ${route.status} ${await route.text()}`);
  await sleep(1500); // APISIX picks objects up from etcd
}

async function tearDown() {
  await admin(`/routes/${ID}`, { method: 'DELETE' });
  await admin(`/ssls/${ID}`, { method: 'DELETE' });
  await fetch(`${OPA}/v1/policies/spikes3`, { method: 'DELETE' });
  await fetch(`${OPA}/v1/data/spikes3`, { method: 'DELETE' });
  docker('exec', 'rid-step-ca-1', 'rm', '-rf', DIR);
}

// --- 3. Calls ---------------------------------------------------------------------------------

/** One HTTPS call to the gateway with an optional client certificate; never throws. */
function call(pki, { client, bearer, headers = {} }) {
  return new Promise((done) => {
    const req = request(
      {
        host: 'localhost',
        port: TLS_PORT,
        servername: SNI,
        path: '/spike-s3/afiliados/1000000001',
        method: 'GET',
        ca: pki.ca,
        ...(client ? { cert: client.cert, key: client.key } : {}),
        headers: { host: SNI, authorization: `Bearer ${bearer}`, ...headers },
        agent: false, // a fresh TLS session per call: no resumption hides the handshake
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          done({
            status: res.statusCode,
            reason: res.headers['x-rid-deny-reason'],
            thumbprint: res.headers['x-rid-debug-thumbprint'],
            sha1: res.headers['x-rid-debug-sha1'],
          }),
        );
      },
    );
    req.on('error', (error) => done({ status: 'tls-error', error: error.code ?? error.message }));
    req.end();
  });
}

const results = [];
const check = (name, got, expect) => {
  const ok = Object.entries(expect).every(([k, v]) => got[k] === v);
  results.push({ name, ok, got });
  console.log(`${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}`);
};

async function main() {
  const pki = certificates();
  const a = x5tS256(pki.a.cert);
  const b = x5tS256(pki.b.cert);
  try {
    await setUp(pki);
    const boundToA = token({ cnf: { 'x5t#S256': a } });
    const boundToB = token({ cnf: { 'x5t#S256': b } });

    const none = await call(pki, { bearer: boundToA });
    check('without a client certificate the handshake fails', none, { status: 'tls-error' });
    const untrusted = await call(pki, { client: pki.intruder, bearer: boundToA });
    check('a certificate from another CA (same subject) fails the handshake', untrusted, {
      status: 'tls-error',
    });

    const since = new Date(Date.now() - 2_000).toISOString();
    const ok = await call(pki, { client: pki.a, bearer: boundToA });
    // OPA removes the listed header it does not return, so it is gone after the decision.
    check('certificate A + token bound to A passes', ok, { status: 200, thumbprint: undefined });
    const sha1 = createHash('sha1').update(new X509Certificate(pki.a.cert).raw).digest('hex');
    check('ssl_client_fingerprint is the SHA-1 of the DER (hex), not x5t#S256', ok, { sha1 });

    check(
      'a token bound to B used with certificate A is denied',
      await call(pki, { client: pki.a, bearer: boundToB }),
      // The gateway's thumbprint equals the one computed here from the PEM (RFC 8705 §3.1).
      { status: 403, reason: 'cert_mismatch', thumbprint: a },
    );
    check(
      'an unbound token is denied when mTLS is required',
      await call(pki, { client: pki.a, bearer: token({}) }),
      { status: 403, reason: 'token_not_bound' },
    );
    check(
      'a thumbprint header sent by the client is replaced by the gateway',
      await call(pki, { client: pki.a, bearer: boundToB, headers: { [HEADER]: b } }),
      { status: 403, reason: 'cert_mismatch', thumbprint: a },
    );

    // Revocation: in production the portal publishes it in the OPA bundle; here, the data API.
    await fetch(`${OPA}/v1/data/spikes3/revoked`, { method: 'PUT', body: JSON.stringify([a]) });
    check(
      'a revoked certificate is denied by OPA (no CRL/OCSP at the gateway)',
      await call(pki, { client: pki.a, bearer: boundToA }),
      { status: 403, reason: 'cert_revoked' },
    );
    check(
      'other certificates of the same CA keep working',
      await call(pki, { client: pki.b, bearer: boundToB }),
      { status: 200 },
    );
    const logs = docker('logs', '--since', since, 'rid-mock-salud-1');
    check(
      'the provider never receives the thumbprint header',
      { leaked: `${logs.stdout}${logs.stderr}`.includes(a) },
      { leaked: false },
    );
  } finally {
    await tearDown();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks as expected`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
