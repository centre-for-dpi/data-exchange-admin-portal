#!/usr/bin/env node
// SPIKE S-1: verifies, against the local Compose stack, how headers set by APISIX's opa plugin
// interact with limit-count, http-logger and the upstream. Run with the stack up:
//   node docs/spikes/S-1/run-spike.mjs
// It creates temporary objects (OPA policy, APISIX route, capture container) and removes them.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const ADMIN = `http://localhost:${process.env.APISIX_ADMIN_PORT ?? 9180}/apisix/admin`;
const GATEWAY = `http://localhost:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
const ROUTE_ID = 'rid-spike-s1';
const PREFIX = '/salud/afiliacion/v1';
const CAPTURE = 'rid-spike-capture';
const NETWORK = 'rid_default';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const admin = (path, init = {}) =>
  fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'x-api-key': process.env.APISIX_ADMIN_KEY, 'content-type': 'application/json' },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GATEWAY_HEADERS = [
  'X-RID-Consumer-Entity',
  'X-RID-Consumer-App',
  'X-RID-Subscription',
  'X-RID-Operation',
  'X-RID-End-User-Hash',
];

const route = {
  uri: `${PREFIX}/*`,
  methods: ['GET'],
  upstream: { type: 'roundrobin', scheme: 'http', nodes: { 'mock-salud:8000': 1 } },
  plugins: {
    // rewrite phase (priority 1008): strip the route prefix and drop gateway-only headers.
    'proxy-rewrite': {
      regex_uri: [`^${PREFIX}/(.*)$`, '/$1'],
      headers: { remove: GATEWAY_HEADERS },
    },
    // access phase (priority 2001): decision + headers for the upstream.
    opa: {
      host: 'http://opa:8181',
      policy: 'rid/spike',
      with_route: true,
      send_headers_upstream: [
        ...GATEWAY_HEADERS,
        'X-RID-End-User', // listed but never returned by the policy -> removed before upstream
        'X-RID-Debug-Path',
        'X-RID-Debug-Route',
      ],
    },
    // access phase (priority 1002, runs after opa): limit keyed by the header OPA just set.
    'limit-count': {
      count: 2,
      time_window: 60,
      key_type: 'var',
      key: 'http_x_rid_subscription',
      rejected_code: 429,
      rejected_msg: 'rate_limited',
      policy: 'local',
    },
    // Turns the 429 produced by limit-count into RFC 9457 problem details.
    'response-rewrite': {
      vars: [['status', '==', 429]],
      headers: { set: { 'Content-Type': 'application/problem+json' } },
      body: JSON.stringify({
        type: 'https://rid.example/errors/rate_limited',
        title: 'Too many requests',
        status: 429,
        code: 'rate_limited',
      }),
    },
    // log phase.
    'http-logger': {
      uri: `http://${CAPTURE}:9999/`,
      batch_max_size: 1,
      inactive_timeout: 1,
      log_format: {
        request_id: '$http_x_request_id',
        subscription: '$http_x_rid_subscription',
        operation: '$http_x_rid_operation',
        end_user: '$http_x_rid_end_user',
        end_user_hash: '$http_x_rid_end_user_hash',
        uri: '$uri',
        upstream_uri: '$upstream_uri',
        status: '$status',
        deny_reason: '$sent_http_x_rid_deny_reason',
      },
    },
  },
};

async function setup() {
  docker('rm', '-f', CAPTURE);
  const server =
    "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{console.log(b);s.end('ok')})}).listen(9999)";
  const run = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    CAPTURE,
    '--network',
    NETWORK,
    // Reuses the local mock-providers image (it ships Node) to avoid pulling another image.
    'rid/mock-providers:dev',
    'node',
    '-e',
    server,
  );
  if (run.status !== 0) throw new Error(run.stderr);

  const policy = await fetch(`${OPA}/v1/policies/rid-spike`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: readFileSync(resolve(here, 'spike.rego'), 'utf8'),
  });
  if (!policy.ok) throw new Error(`OPA policy: ${policy.status} ${await policy.text()}`);

  const created = await admin(`/routes/${ROUTE_ID}`, {
    method: 'PUT',
    body: JSON.stringify(route),
  });
  if (!created.ok) throw new Error(`APISIX route: ${created.status} ${await created.text()}`);
  await sleep(1500); // route propagation from etcd
}

async function cleanup() {
  await admin(`/routes/${ROUTE_ID}`, { method: 'DELETE' });
  await fetch(`${OPA}/v1/policies/rid-spike`, { method: 'DELETE' });
  docker('rm', '-f', CAPTURE);
}

async function call(name, headers) {
  const requestId = `${name}-${randomUUID().slice(0, 8)}`;
  const res = await fetch(`${GATEWAY}${PREFIX}/afiliados/1000000001?debug=1`, {
    headers: { 'x-request-id': requestId, ...headers },
  });
  return {
    name,
    requestId,
    status: res.status,
    contentType: res.headers.get('content-type'),
    denyReason: res.headers.get('x-rid-deny-reason'),
    body: (await res.text()).slice(0, 200),
  };
}

function upstreamSaw(requestId, since) {
  const logs = docker('logs', '--since', since, 'rid-mock-salud-1');
  const line = `${logs.stdout}${logs.stderr}`.split('\n').find((l) => l.includes(requestId));
  return line ? JSON.parse(line).rid : undefined;
}

function loggerSaw(requestId) {
  const logs = docker('logs', CAPTURE);
  for (const line of `${logs.stdout}`.split('\n')) {
    if (!line.includes(requestId)) continue;
    const parsed = JSON.parse(line);
    return (Array.isArray(parsed) ? parsed : [parsed]).find((e) => e.request_id === requestId);
  }
  return undefined;
}

async function main() {
  await setup();
  try {
    const since = new Date(Date.now() - 2000).toISOString();
    const spoof = {
      'x-rid-purpose': 'eligibility_check',
      'x-rid-subscription': 'sub-SPOOFED',
      'x-rid-operation': 'deleteEverything',
      'x-rid-end-user': '52123456',
    };
    const calls = [];
    calls.push(await call('A1-spoofed', { ...spoof, 'x-test-client': 'a' }));
    calls.push(await call('A2', { 'x-rid-purpose': 'eligibility_check', 'x-test-client': 'a' }));
    calls.push(
      await call('A3-over-limit', { 'x-rid-purpose': 'eligibility_check', 'x-test-client': 'a' }),
    );
    calls.push(
      await call('B1-other-subscription', {
        'x-rid-purpose': 'eligibility_check',
        'x-test-client': 'b',
      }),
    );
    calls.push(
      await call('D1-denied', { 'x-rid-purpose': 'benefit_targeting', 'x-test-client': 'd' }),
    );
    calls.push(
      await call('D2-denied', { 'x-rid-purpose': 'benefit_targeting', 'x-test-client': 'd' }),
    );
    calls.push(
      await call('D3-denied', { 'x-rid-purpose': 'benefit_targeting', 'x-test-client': 'd' }),
    );

    await sleep(3000); // http-logger batches
    for (const c of calls) {
      c.upstream = upstreamSaw(c.requestId, since);
      c.logger = loggerSaw(c.requestId);
    }
    console.log(JSON.stringify(calls, null, 2));
    if (process.argv.includes('--debug')) {
      console.error(
        'capture status:',
        docker('ps', '-a', '--filter', `name=${CAPTURE}`, '--format', '{{.Status}}').stdout,
      );
      console.error('capture output:', docker('logs', CAPTURE).stdout.slice(0, 2000));
    }
  } finally {
    await cleanup();
  }
}

await main();
