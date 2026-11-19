import { createHmac, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPolicies } from '../../opa/policy-files.js';
import { HttpApisixAdmin } from './apisix-admin.js';
import { desiredGateway, type GatewaySettings, parseDevNodes } from './desired-state.js';

const GATEWAY = `http://127.0.0.1:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
// Outside the reconciler's den- prefix and the bundle's roots: nothing else manages them.
const ROUTE = 'test-m3-07-spoofing';
const PACKAGE = 'dentestm307';
const BASE = '/__den_m3_07__/afiliacion/v1';
const SALT = 'm3-07-end-user-salt-0123456789';
const SUBJECT_KEY = 'm3-07-subject-ref-key-0123456789abcdef';
const CLIENT = 'den-app-m3-07';
const SUBSCRIPTION = '0190d0c4-0000-7000-8000-0000000m3007'.replace('m', 'a');

/** Every X-DEN-* a malicious consumer could send, with a value the provider must never get. */
const FORGED: Record<string, string> = {
  'X-DEN-Consumer-Entity': 'entidad-falsa',
  'X-DEN-Consumer-App': 'den-app-falsa',
  'X-DEN-Subscription': 'sub-falsa',
  'X-DEN-Operation': 'deleteEverything',
  'X-DEN-End-User-Hash': 'hash-falso',
  'X-DEN-Subject-Ref': 'ref-falsa',
  'X-DEN-Rate-Limit': '1000000',
  'X-DEN-Body-Subject': 'CC:999',
  'X-DEN-Data-Subject': 'CC:999',
  'X-DEN-Client-Cert-S256': 'huella-falsa',
  'X-DEN-Deny-Reason': 'nada',
  'X-DEN-Anything-New': 'cabecera-futura',
};

const hmac = (value: string, key: string) => createHmac('sha256', key).update(value).digest('hex');
/** Unsigned: on this route the policy only decodes the token (openid-connect is tested apart). */
const token = (azp: string) =>
  [{ alg: 'none', typ: 'JWT' }, { azp }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')
    .concat('.');

/**
 * Anti-spoofing of X-DEN-* headers (M3-07), against the real APISIX and OPA with the real
 * policy (packages/policy, loaded under a test package so it does not touch the portal's bundle)
 * and the plugin chain the reconciler writes. A provider on the host answers with the headers it
 * received. Only openid-connect is left out of the route: the policy decodes the token, and the
 * signature check is covered by the gateway e2e.
 */
describe('a consumer cannot forge the X-DEN-* headers the provider receives (M3-07)', () => {
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  let provider: Server;
  let received: Array<Record<string, string | string[] | undefined>> = [];

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

  beforeAll(async () => {
    provider = createServer((req, res) => {
      received.push(req.headers);
      res.setHeader('content-type', 'application/json');
      // A provider faking what the gateway tells the consumer and the access log (M5-01).
      res.setHeader('X-DEN-Deny-Reason', 'nada');
      res.setHeader('X-DEN-Consumer-App', 'den-app-falsa');
      res.setHeader('x_den_consumer_entity', 'entidad-falsa');
      res.end('{"regimen":"contributivo"}');
    });
    await new Promise<void>((resolve) => provider.listen(0, '0.0.0.0', () => resolve()));
    const port = (provider.address() as AddressInfo).port;

    // The real policy, renamed: package and data paths under dentestm307.
    for (const { path, source } of readPolicies()) {
      if (path.endsWith('_test.rego')) continue;
      const renamed = source
        .replace(/^package den\.authz/m, `package ${PACKAGE}.authz`)
        .replace(/data\.(routes|clients|config)\b/g, `data.${PACKAGE}.$1`);
      const res = await fetch(`${OPA}/v1/policies/${PACKAGE}-${path.replace(/\W/g, '-')}`, {
        method: 'PUT',
        body: renamed,
      });
      expect(res.status, await res.text()).toBe(200);
    }
    const data = {
      routes: {
        [ROUTE]: {
          apiVersionId: randomUUID(),
          classification: 'personal',
          operations: [
            {
              id: 'getAfiliado',
              method: 'GET',
              pathRegex: `^${BASE}/afiliados/[^/]+$`,
              subject: {
                in: 'path',
                regex: `^${BASE}/afiliados/([^/]+)$`,
                numberGroup: 1,
                documentType: 'CC',
              },
            },
          ],
        },
      },
      clients: {
        [CLIENT]: {
          status: 'active',
          entityId: randomUUID(),
          entitySlug: 'programas-sociales',
          applicationId: randomUUID(),
          certificates: [],
          subscriptions: [
            {
              id: SUBSCRIPTION,
              route: ROUTE,
              operations: ['getAfiliado'],
              purposes: ['eligibility_check'],
              validFrom: '2026-01-01T00:00:00Z',
              validUntil: '2036-01-01T00:00:00Z',
              endUserRequired: true,
              rateLimitPerMinute: 100,
            },
          ],
        },
      },
      config: {
        endUserHashSalt: SALT,
        subjectRefKey: SUBJECT_KEY,
        country: 'CO',
        documentTypes: ['CC'],
        documentNumberFormats: { CC: '^[1-9][0-9]{2,9}$' },
        mtlsRequired: false,
        gatewayNodes: 1,
      },
    };
    const put = await fetch(`${OPA}/v1/data/${PACKAGE}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    expect(put.status).toBe(204);

    // The plugin chain of a real route, pointed at the test policy and the provider on the host.
    const { route } = desiredGateway(
      {
        id: randomUUID(),
        entityId: randomUUID(),
        basePath: BASE,
        upstream: { type: 'node', servicePath: '/servicio' },
        methods: ['GET'],
        bodySubjects: [],
        hasDataSubjects: true,
        entitySlug: 'salud',
        apiName: 'M3-07',
        version: '1.0',
      },
      settings,
    );
    const plugins = { ...(route.plugins as Record<string, Record<string, unknown>>) };
    delete plugins['openid-connect'];
    delete plugins['http-logger'];
    delete plugins['tcp-logger'];
    plugins.opa = { ...plugins.opa, policy: `${PACKAGE}/authz` };
    await admin.put('routes', ROUTE, {
      uri: `${BASE}/*`,
      methods: ['GET'],
      upstream: {
        type: 'roundrobin',
        scheme: 'http',
        nodes: { [`host.docker.internal:${port}`]: 1 },
      },
      plugins,
    });
    for (let i = 0; i < 40 && (await fetch(`${GATEWAY}${BASE}/x`)).status === 404; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  afterAll(async () => {
    await admin.delete('routes', ROUTE);
    for (const { path } of readPolicies()) {
      await fetch(`${OPA}/v1/policies/${PACKAGE}-${path.replace(/\W/g, '-')}`, {
        method: 'DELETE',
      });
    }
    await fetch(`${OPA}/v1/data/${PACKAGE}`, { method: 'DELETE' });
    provider.close();
  });

  const call = async (headers: Record<string, string>) => {
    received = [];
    const res = await fetch(`${GATEWAY}${BASE}/afiliados/1000000001`, {
      headers: {
        authorization: `Bearer ${token(CLIENT)}`,
        'x-den-purpose': 'eligibility_check',
        'x-den-end-user': 'funcionario-42',
        ...headers,
      },
    });
    await res.arrayBuffer();
    return { status: res.status, seen: received[0], response: res.headers };
  };

  it('the provider receives the values OPA decided, never the forged ones', async () => {
    const { status, seen } = await call(FORGED);
    expect(status).toBe(200);
    expect(seen).toMatchObject({
      'x-den-consumer-entity': 'programas-sociales',
      'x-den-consumer-app': CLIENT,
      'x-den-subscription': SUBSCRIPTION,
      'x-den-operation': 'getAfiliado',
      'x-den-purpose': 'eligibility_check',
      'x-den-rate-limit': '100',
      'x-den-end-user-hash': hmac('funcionario-42', SALT),
      'x-den-subject-ref': hmac('CO|CC|1000000001', SUBJECT_KEY),
    });
  });

  it('the values in clear and the gateway inputs never reach the provider', async () => {
    const { seen } = await call(FORGED);
    for (const header of [
      'x-den-end-user',
      'x-den-body-subject',
      'x-den-data-subject',
      'x-den-client-cert-s256',
      'x-den-deny-reason',
      'x-den-anything-new',
    ]) {
      expect(seen, header).not.toHaveProperty(header);
    }
    // Nothing forged survives under any X-DEN-* name.
    for (const [name, value] of Object.entries(seen ?? {})) {
      if (name.startsWith('x-den-')) expect(Object.values(FORGED), name).not.toContain(value);
    }
  });

  it("the consumer's access token never reaches the provider (M-11)", async () => {
    const { status, seen } = await call({ 'X-Access-Token': token(CLIENT) });
    expect(status).toBe(200);
    expect(seen).not.toHaveProperty('authorization');
    expect(seen).not.toHaveProperty('x-access-token');
    expect(JSON.stringify(seen)).not.toContain(token(CLIENT));
  });

  it('header spelling tricks do not get a forged value through', async () => {
    const { status, seen } = await call({
      'x-DeN-sUbScRiPtIoN': 'sub-falsa',
      X_DEN_Subscription: 'sub-falsa',
      'X-DEN-Operation': 'deleteEverything',
    });
    expect(status).toBe(200);
    expect(seen?.['x-den-subscription']).toBe(SUBSCRIPTION);
    expect(seen?.['x-den-operation']).toBe('getAfiliado');
    expect(JSON.stringify(seen)).not.toContain('sub-falsa');
    expect(JSON.stringify(seen)).not.toContain('deleteEverything');
    // CGI-style servers read X_DEN_* and X-DEN-* as the same variable: no underscore form passes.
    expect(Object.keys(seen ?? {}).filter((h) => /^x_den_/i.test(h))).toEqual([]);
  });

  it('a forged header sent twice is removed as well', async () => {
    received = [];
    const port = Number(process.env.APISIX_HTTP_PORT ?? 9080);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `${BASE}/afiliados/1000000001`,
          headers: {
            authorization: `Bearer ${token(CLIENT)}`,
            'x-den-purpose': 'eligibility_check',
            'x-den-end-user': 'funcionario-42',
            'x-den-subject-ref': ['ref-falsa-1', 'ref-falsa-2'],
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(received[0]?.['x-den-subject-ref']).toBe(hmac('CO|CC|1000000001', SUBJECT_KEY));
  });

  it('a provider cannot send X-DEN-* response headers to the consumer or the log (M5-01)', async () => {
    const { status, response } = await call({});
    expect(status).toBe(200);
    expect([...response.keys()].filter((name) => /^x-den-/i.test(name))).toEqual([]);
    expect(JSON.stringify([...response.entries()])).not.toContain('den-app-falsa');
  });

  it('a denial names the reason and a known consumer, for the access log (M5-03)', async () => {
    const res = await fetch(`${GATEWAY}${BASE}/afiliados/1000000001`, {
      headers: { authorization: `Bearer ${token(CLIENT)}`, 'x-den-purpose': 'benefit_targeting' },
    });
    await res.arrayBuffer();
    expect(res.status).toBe(403);
    expect(res.headers.get('x-den-deny-reason')).toBe('purpose_not_allowed');
    expect(res.headers.get('x-den-consumer-app')).toBe(CLIENT);
    expect(res.headers.get('x-den-consumer-entity')).toBe('programas-sociales');
  });

  it('a forged header cannot turn a denied call into an allowed one', async () => {
    const res = await fetch(`${GATEWAY}${BASE}/afiliados/1000000001`, {
      headers: {
        authorization: `Bearer ${token('den-app-unknown')}`,
        'x-den-purpose': 'eligibility_check',
        'x-den-end-user': 'funcionario-42',
        'x-den-subscription': SUBSCRIPTION,
        'x-den-consumer-app': CLIENT,
      },
    });
    received = [];
    expect(res.status).toBe(403);
    expect(res.headers.get('x-den-deny-reason')).toBe('no_subscription');
    // An unknown client is not named, whatever it sent.
    expect(res.headers.get('x-den-consumer-app')).toBeNull();
    expect(received).toHaveLength(0);
  });
});
