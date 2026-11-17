import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpApisixAdmin } from './apisix-admin.js';
import { desiredGateway, type GatewaySettings, parseDevNodes } from './desired-state.js';

const GATEWAY = `http://127.0.0.1:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
// Outside the reconciler's den- prefix and the bundle's roots: nothing else manages them.
const ROUTE = 'test-m3-05-limit';
const PROVIDER_ROUTE = 'test-m3-05-provider';
const PROXIED_ROUTE = 'test-m3-05-proxied';
const POLICY = 'dentestm305';
const PATH = '/__den_m3_05__';

/**
 * Per-subscription limit against the real APISIX and OPA (SPIKE S-2 turned into a test, M3-05).
 * The route carries the limit-count and den-rate-limited configuration the reconciler writes;
 * a stand-in policy plays den.authz: it puts X-DEN-Subscription and X-DEN-Rate-Limit, like the
 * real one (tested with opa test), from data the test changes.
 */
describe('per-subscription limit at the gateway (M3-05)', () => {
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  const run = randomUUID().slice(0, 8);
  const settings: GatewaySettings = {
    keycloakDiscoveryUrl:
      'http://keycloak:8080/realms/den-gateway/.well-known/openid-configuration',
    audience: 'den-gateway',
    opaUrl: 'http://opa:8181',
    accessLogUrl: 'http://fluent-bit:9880/',
    transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
    devNodes: parseDevNodes('salud=mock-salud:8000'),
    resolveHost: () => Promise.resolve([]),
    tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'den-gateway' },
  };
  const plugins = desiredGateway(
    {
      id: randomUUID(),
      entityId: randomUUID(),
      basePath: '/salud/m3-05/v1',
      upstream: { type: 'node', servicePath: '/' },
      methods: ['GET'],
      bodySubjects: [],
      hasDataSubjects: false,
      entitySlug: 'salud',
      apiName: 'M3-05',
      version: '1.0',
    },
    settings,
  ).route.plugins as Record<string, Record<string, unknown>>;

  /** The stand-in for den.authz: client -> subscription and its limit, from data.dentestm305. */
  const policy = `package ${POLICY}

import rego.v1

client := input.request.headers["x-test-client"]

grant := data.${POLICY}.grants[client]

default allow := false

allow if grant

headers := {"X-DEN-Subscription": grant.subscription, "X-DEN-Rate-Limit": format_int(grant.limit, 10)} if allow

headers := {"Content-Type": "application/problem+json", "X-DEN-Deny-Reason": "no_subscription"} if not allow

status_code := 403
`;
  const grants: Record<string, { subscription: string; limit: number }> = {
    a: { subscription: `sub-a-${run}`, limit: 2 },
    b: { subscription: `sub-b-${run}`, limit: 4 },
    c: { subscription: `sub-c-${run}`, limit: 3 },
  };
  const putGrants = async () => {
    const res = await fetch(`${OPA}/v1/data/${POLICY}`, {
      method: 'PUT',
      body: JSON.stringify({ grants }),
    });
    expect(res.status).toBe(204);
  };

  const call = async (client: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${GATEWAY}${PATH}/consulta`, {
      headers: { 'x-test-client': client, ...headers },
    });
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      limit: res.headers.get('x-ratelimit-limit'),
      denyReason: res.headers.get('x-den-deny-reason'),
      body: await res.text(),
    };
  };
  const statuses = async (client: string, n: number, headers?: Record<string, string>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) out.push((await call(client, headers)).status);
    return out;
  };

  beforeAll(async () => {
    const res = await fetch(`${OPA}/v1/policies/${POLICY}`, { method: 'PUT', body: policy });
    expect(res.status, await res.text()).toBe(200);
    await putGrants();
    await admin.put('routes', ROUTE, {
      uri: `${PATH}/*`,
      methods: ['GET'],
      upstream: { type: 'roundrobin', scheme: 'http', nodes: { 'mock-salud:8000': 1 } },
      plugins: {
        'proxy-rewrite': { uri: '/health' },
        opa: {
          host: 'http://opa:8181',
          policy: POLICY,
          send_headers_upstream: ['X-DEN-Subscription', 'X-DEN-Rate-Limit'],
        },
        'limit-count': plugins['limit-count'],
        'den-rate-limited': plugins['den-rate-limited'],
      },
    });
    // A provider that answers 429 itself, reached through a route with den-rate-limited.
    await admin.put('routes', PROVIDER_ROUTE, {
      uri: `${PATH}-provider`,
      plugins: { 'fault-injection': { abort: { http_status: 429, body: 'provider: slow down' } } },
    });
    await admin.put('routes', PROXIED_ROUTE, {
      uri: `${PATH}-proxied`,
      upstream: { type: 'roundrobin', scheme: 'http', nodes: { '127.0.0.1:9080': 1 } },
      plugins: {
        'proxy-rewrite': { uri: `${PATH}-provider` },
        'den-rate-limited': {},
      },
    });
    // APISIX applies what etcd says within moments.
    for (let i = 0; i < 40 && (await call('nobody')).status === 404; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  afterAll(async () => {
    for (const id of [ROUTE, PROXIED_ROUTE, PROVIDER_ROUTE]) await admin.delete('routes', id);
    await fetch(`${OPA}/v1/policies/${POLICY}`, { method: 'DELETE' });
    await fetch(`${OPA}/v1/data/${POLICY}`, { method: 'DELETE' });
  });

  it('applies each subscription its own limit, with the quota headers', async () => {
    expect(await statuses('a', 3)).toEqual([200, 200, 429]);
    expect(await statuses('b', 5)).toEqual([200, 200, 200, 200, 429]);
    const first = await call('c');
    expect(first.status).toBe(200);
    expect(first.limit).toBe('3');
  });

  it("answers the gateway's own 429 in problem+json", async () => {
    const limited = await call('a');
    expect(limited.status).toBe(429);
    expect(limited.contentType).toBe('application/problem+json');
    expect(JSON.parse(limited.body)).toMatchObject({
      type: 'https://den.example/errors/rate_limited',
      status: 429,
      code: 'rate_limited',
    });
    // A refusal of the gateway: the access log counts it with its reason (M5-03).
    expect(limited.denyReason).toBe('rate_limited');
  });

  it('a client can neither raise its limit nor reset its counter', async () => {
    expect(await statuses('a', 1, { 'X-DEN-Rate-Limit': '1000' })).toEqual([429]);
    expect(await statuses('a', 1, { 'X-DEN-Subscription': `fresh-${run}` })).toEqual([429]);
  });

  it('a call OPA denies never reaches the limit (403, no quota headers)', async () => {
    const denied = await call('nobody');
    expect(denied.status).toBe(403);
    expect(denied.limit).toBeNull();
  });

  it('changing the limit keeps the counter of the window', async () => {
    // c made one call (limit 3); lowered to 1, the next call is already over it.
    grants.c = { subscription: `sub-c-${run}`, limit: 1 };
    await putGrants();
    expect(await statuses('c', 1)).toEqual([429]);
  });

  it("lets a provider's own 429 through untouched", async () => {
    const res = await fetch(`${GATEWAY}${PATH}-proxied`);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('provider: slow down');
    expect(res.headers.get('content-type')).not.toBe('application/problem+json');
    expect(res.headers.get('x-den-deny-reason')).toBeNull();
  });
});
