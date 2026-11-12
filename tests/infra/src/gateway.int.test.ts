import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { env } from './env.js';

const port = (name: string, fallback: number): number => Number(env(name, String(fallback)));
const gatewayUrl = (): string => `http://localhost:${port('APISIX_HTTP_PORT', 9080)}`;
const adminUrl = (): string => `http://localhost:${port('APISIX_ADMIN_PORT', 9180)}/apisix/admin`;
const opaUrl = (): string => `http://localhost:${port('OPA_PORT', 8181)}`;

const asAdmin = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${adminUrl()}${path}`, {
    ...init,
    headers: {
      'x-api-key': env('APISIX_ADMIN_KEY'),
      'content-type': 'application/json',
      ...init.headers,
    },
  });

function canConnect(host: string, tcpPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: tcpPort, timeout: 2_000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function containerLogsSince(container: string, since: string): string {
  const result = spawnSync('docker', ['logs', '--since', since, container], { encoding: 'utf8' });
  return `${result.stdout}${result.stderr}`;
}

describe('APISIX (M0-04)', () => {
  it('requires the admin key on the Admin API', async () => {
    const anonymous = await fetch(`${adminUrl()}/routes`);
    expect(anonymous.status).toBe(401);
    expect((await asAdmin('/routes')).status).toBe(200);
  });

  it('does not publish etcd on the host', async () => {
    expect(await canConnect('127.0.0.1', 2379)).toBe(false);
  });

  it('has no route for unknown paths (nothing is published by hand)', async () => {
    const res = await fetch(`${gatewayUrl()}/unknown-${randomUUID()}/v1/afiliados/1000000001`);
    expect(res.status).toBe(404);
  });

  it('never writes the request path to its own logs (rule 2, ARCHITECTURE.md §8)', async () => {
    // Paths carry identification numbers: nginx's access log is off and only http-logger, with
    // the allow-listed fields, records requests.
    const since = new Date(Date.now() - 1_000).toISOString();
    const identifier = String(Date.now()).slice(-10);
    await fetch(
      `${gatewayUrl()}/unknown-${randomUUID()}/v1/afiliados/${identifier}?doc=${identifier}`,
    );
    await new Promise((r) => setTimeout(r, 1_000));
    expect(containerLogsSince('rid-apisix-1', since)).not.toContain(identifier);
  });
});

describe('APISIX reaches the mock providers over the Compose network (M0-04)', () => {
  // Temporary route created directly through the Admin API for this connectivity test only.
  // Real routes are created by the portal reconciler (M1-08), never by hand.
  const routeId = `rid-test-${randomUUID()}`;
  const prefix = `/__rid-test/${routeId}`;

  afterAll(async () => {
    await asAdmin(`/routes/${routeId}`, { method: 'DELETE' });
  });

  it('proxies a call to mock-salud and the provider logs trace headers, not the identifier', async () => {
    const created = await asAdmin(`/routes/${routeId}`, {
      method: 'PUT',
      body: JSON.stringify({
        uri: `${prefix}/*`,
        methods: ['GET'],
        upstream: { type: 'roundrobin', scheme: 'http', nodes: { 'mock-salud:8000': 1 } },
        plugins: {
          'proxy-rewrite': { regex_uri: [`^${prefix}/(.*)$`, '/$1'] },
        },
      }),
    });
    expect([200, 201]).toContain(created.status);

    const since = new Date(Date.now() - 1_000).toISOString();
    const requestId = randomUUID();
    let res: Response | undefined;
    // APISIX picks up new routes from etcd asynchronously; retry briefly.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      res = await fetch(`${gatewayUrl()}${prefix}/afiliados/1000000001`, {
        headers: { 'x-rid-purpose': 'eligibility_check', 'x-request-id': requestId },
      });
      if (res.status !== 404) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as { numeroIdentificacion: string }).numeroIdentificacion).toBe(
      '1000000001',
    );

    const logs = containerLogsSince('rid-mock-salud-1', since);
    const line = logs.split('\n').find((l) => l.includes(requestId));
    expect(line, logs.slice(-500)).toBeDefined();
    expect(line).toContain('"x-rid-purpose":"eligibility_check"');
    expect(line).toContain('"route":"/afiliados/:numeroIdentificacion"');
    expect(logs).not.toContain('1000000001');
  });
});

describe('mock providers on the host (M0-04)', () => {
  it.each([
    ['MOCK_SALUD_PORT', 8101, 'salud'],
    ['MOCK_SOCIOECONOMICO_PORT', 8102, 'socioeconomico'],
  ] as const)('%s serves health and its OpenAPI document', async (name, fallback, provider) => {
    const base = `http://localhost:${port(name, fallback)}`;
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok', provider });
    const spec = await fetch(`${base}/openapi.yaml`);
    expect(spec.status).toBe(200);
    expect(await spec.text()).toMatch(/^openapi: 3\.1\.0/);
  });
});

describe('OPA (M0-04)', () => {
  it('is configured to pull the rid bundle from the portal API, without decision logs', async () => {
    const res = await fetch(`${opaUrl()}/v1/config`);
    const { result } = (await res.json()) as {
      result: {
        services: Record<string, { url: string; credentials?: unknown }>;
        bundles: Record<string, { service: string; resource: string }>;
        decision_logs?: unknown;
      };
    };
    expect(result.services.portal?.url).toMatch(/\/api\/v1\/opa$/);
    expect(result.bundles.rid).toMatchObject({ service: 'portal', resource: 'bundle.tar.gz' });
    expect(result.decision_logs).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(env('OPA_BUNDLE_TOKEN'));
  });

  it('denies by default while no bundle is loaded', async () => {
    const res = await fetch(`${opaUrl()}/v1/data/rid/authz/allow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });
    const body = (await res.json()) as { result?: unknown };
    expect(body.result === undefined || body.result === false).toBe(true);
  });
});
