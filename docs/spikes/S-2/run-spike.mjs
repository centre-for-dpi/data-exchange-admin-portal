#!/usr/bin/env node
// SPIKE S-2: a rate limit per subscription at APISIX, with the limit itself decided by OPA from
// the bundle (not fixed in the route). Run with the stack up:
//   node docs/spikes/S-2/run-spike.mjs
// It creates a temporary OPA policy and APISIX route and removes them at the end.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const ADMIN = `http://localhost:${process.env.APISIX_ADMIN_PORT ?? 9180}/apisix/admin`;
const GATEWAY = `http://localhost:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
const ID = 'rid-spike-s2';
const PREFIX = '/spike-s2';

const admin = (path, init = {}) =>
  fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'x-api-key': process.env.APISIX_ADMIN_KEY, 'content-type': 'application/json' },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The spike's stand-in for the bundle: who the client is (here a plain header instead of the
// token) and the limit of its subscription, in requests per minute.
const POLICY = `package spikes2

import rego.v1

subscriptions := {
	"app-a": {"id": "sub-a", "rateLimit": 2},
	"app-b": {"id": "sub-b", "rateLimit": 4},
}

sub := subscriptions[input.request.headers["x-spike-client"]]

default allow := false

allow if sub

headers := {
	"X-RID-Subscription": sub.id,
	"X-RID-Rate-Limit": format_int(sub.rateLimit, 10),
} if sub

headers := {"X-RID-Deny-Reason": "no_subscription"} if not sub

status_code := 403
`;

// Only the gateway's own 429 becomes problem+json: when limit-count rejects there is no upstream,
// so $upstream_status is empty; a provider's 429 keeps its body.
const PROBLEM_429 = {
  vars: [
    ['status', '==', 429],
    ['upstream_status', '!', '~~', '[0-9]'],
  ],
  headers: { set: { 'Content-Type': 'application/problem+json' } },
  body: JSON.stringify({
    type: 'https://rid.example/errors/rate_limited',
    title: 'Too many requests',
    status: 429,
    code: 'rate_limited',
  }),
};

async function setUp() {
  const policy = await fetch(`${OPA}/v1/policies/spikes2`, { method: 'PUT', body: POLICY });
  if (!policy.ok) throw new Error(`policy: ${policy.status} ${await policy.text()}`);
  const route = await admin(`/routes/${ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      uri: `${PREFIX}/*`,
      methods: ['GET'],
      upstream: { type: 'roundrobin', scheme: 'http', nodes: { 'mock-salud:8000': 1 } },
      plugins: {
        'proxy-rewrite': { regex_uri: [`^${PREFIX}/(.*)$`, '/$1'] },
        // access phase, priority 2001: decides, and sets subscription and limit on the request.
        // Both are listed, so a value sent by the client is replaced or removed (SPIKE S-1).
        opa: {
          host: 'http://opa:8181',
          policy: 'spikes2',
          send_headers_upstream: ['X-RID-Subscription', 'X-RID-Rate-Limit'],
        },
        // access phase, priority 1002 (after opa): the count and the key come from OPA's headers.
        'limit-count': {
          count: '$http_x_rid_rate_limit',
          time_window: 60,
          key_type: 'var',
          key: 'http_x_rid_subscription',
          policy: 'local',
          rejected_code: 429,
          rejected_msg: 'rate_limited',
          show_limit_quota_header: true,
        },
        'response-rewrite': PROBLEM_429,
      },
    }),
  });
  if (!route.ok) throw new Error(`route: ${route.status} ${await route.text()}`);
  // A provider that answers 429 itself (fault-injection stands in for it), reached through a
  // second route of the gateway with the same response-rewrite.
  const provider = await admin(`/routes/${ID}-provider`, {
    method: 'PUT',
    body: JSON.stringify({
      uri: '/spike-s2-provider',
      plugins: { 'fault-injection': { abort: { http_status: 429, body: 'provider: slow down' } } },
    }),
  });
  if (!provider.ok) throw new Error(`provider: ${provider.status} ${await provider.text()}`);
  const proxied = await admin(`/routes/${ID}-proxied`, {
    method: 'PUT',
    body: JSON.stringify({
      uri: '/spike-s2-proxied',
      upstream: { type: 'roundrobin', scheme: 'http', nodes: { '127.0.0.1:9080': 1 } },
      plugins: {
        'proxy-rewrite': { uri: '/spike-s2-provider' },
        'response-rewrite': PROBLEM_429,
      },
    }),
  });
  if (!proxied.ok) throw new Error(`proxied: ${proxied.status} ${await proxied.text()}`);
  await sleep(1500);
}

async function tearDown() {
  await admin(`/routes/${ID}`, { method: 'DELETE' });
  await admin(`/routes/${ID}-provider`, { method: 'DELETE' });
  await admin(`/routes/${ID}-proxied`, { method: 'DELETE' });
  await fetch(`${OPA}/v1/policies/spikes2`, { method: 'DELETE' });
}

const call = async (client, headers = {}) => {
  const res = await fetch(`${GATEWAY}${PREFIX}/afiliados/1000000001`, {
    headers: { 'x-spike-client': client, ...headers },
  });
  await res.arrayBuffer();
  return {
    status: res.status,
    limit: res.headers.get('x-ratelimit-limit'),
    remaining: res.headers.get('x-ratelimit-remaining'),
  };
};
const statuses = async (client, n, headers) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await call(client, headers));
  return out;
};

const results = [];
const check = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}`);
};

async function main() {
  try {
    await setUp();
    const a = await statuses('app-a', 3);
    check(
      'subscription A (limit 2) gets 429 on its third call',
      a.map((r) => r.status),
      [200, 200, 429],
    );
    check('the quota headers show the limit OPA set', a[0].limit, '2');
    const b = await statuses('app-b', 5);
    check(
      'subscription B (limit 4), same route and IP, has its own counter and limit',
      b.map((r) => r.status),
      [200, 200, 200, 200, 429],
    );
    check(
      'a client cannot raise its limit by sending X-RID-Rate-Limit itself',
      (await statuses('app-a', 1, { 'X-RID-Rate-Limit': '1000' })).map((r) => r.status),
      [429],
    );
    check(
      'nor can it reset its counter by sending another X-RID-Subscription',
      (await statuses('app-a', 1, { 'X-RID-Subscription': 'sub-fresh' })).map((r) => r.status),
      [429],
    );
    const limited = await fetch(`${GATEWAY}${PREFIX}/afiliados/1000000001`, {
      headers: { 'x-spike-client': 'app-a' },
    });
    check(
      "the gateway's own 429 is problem+json",
      { type: limited.headers.get('content-type'), code: (await limited.json()).code },
      { type: 'application/problem+json', code: 'rate_limited' },
    );
    const theirs = await fetch(`${GATEWAY}/spike-s2-proxied`);
    check(
      "a provider's 429 passes through untouched",
      { status: theirs.status, body: await theirs.text() },
      { status: 429, body: 'provider: slow down' },
    );
    check(
      'a call OPA denies never reaches limit-count (403, no quota headers)',
      await call('nobody'),
      { status: 403, limit: null, remaining: null },
    );
  } finally {
    await tearDown();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks as expected`);
  process.exitCode = failed ? 1 : 0;
}

await main();
