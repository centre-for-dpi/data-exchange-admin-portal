import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPolicies } from '../../opa/policy-files.js';
import { HttpApisixAdmin } from './apisix-admin.js';
import { opaAdminFetch, opaDecisionToken } from '../../../test/opa.js';
import { desiredGateway, type GatewaySettings, opaPolicy, parseDevNodes } from './desired-state.js';

const GATEWAY = `http://127.0.0.1:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
// Outside the reconciler's den- prefix and the bundle's roots: nothing else manages them.
const ROUTE = 'test-m4-05-xroad';
const PACKAGE = 'dentestm405';
const BASE = '/__den_m4_05__/hogares/v1';
const SALT = 'm4-05-end-user-salt-0123456789';
const CLIENT = 'den-app-m4-05';
const SUBSCRIPTION = '0190d0c4-0000-7000-8000-0000000a4005';
const OPERATOR = 'CO/GOV/9000000001/DEN-GATEWAY';
const SERVICE = {
  instance: 'CO',
  memberClass: 'GOV',
  memberCode: '8999999999',
  subsystemCode: 'REGISTRO SOCIAL',
  serviceCode: 'consultaHogar',
};

const token = (azp: string) =>
  [{ alg: 'none', typ: 'JWT' }, { azp }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')
    .concat('.');

interface Seen {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * xroad upstream (M4-05, SPIKE S-5) against the real APISIX and OPA with the real policy, and a
 * simulated consumer Security Server on the host (PR-REST r1: it checks the URL and X-Road-Client,
 * like the spike's). Only openid-connect is left out of the route, as in the spoofing test.
 */
describe('X-Road upstream through the operator Security Server (M4-05)', () => {
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  let server: Server;
  let seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      const ok = req.headers['x-road-client'] === OPERATOR && (req.url ?? '').startsWith('/r1/');
      res.writeHead(ok ? 200 : 400, {
        'content-type': 'application/json',
        ...(ok ? { 'x-road-service': Object.values(SERVICE).join('/') } : {}),
      });
      res.end(ok ? '{"hogar":"sintetico"}' : '{"type":"Client.InvalidClient"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    for (const { path, source } of readPolicies()) {
      if (path.endsWith('_test.rego')) continue;
      const renamed = source
        .replace(/^package den\.authz/m, `package ${PACKAGE}.authz`)
        .replace(/data\.(routes|clients|config)\b/g, `data.${PACKAGE}.$1`);
      const res = await opaAdminFetch(`${OPA}/v1/policies/${PACKAGE}-${path.replace(/\W/g, '-')}`, {
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
          xroad: true,
          operations: [
            {
              id: 'getHogar',
              method: 'GET',
              pathRegex: `^${BASE}/hogares/[^/]+$`,
              subject: { in: 'none' },
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
              operations: ['getHogar'],
              purposes: ['benefit_targeting'],
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
        subjectRefKey: 'm4-05-subject-ref-key-0123456789abcdef',
        country: 'CO',
        documentTypes: ['CC'],
        documentNumberFormats: { CC: '^[1-9][0-9]{2,9}$' },
        mtlsRequired: false,
        gatewayNodes: 1,
      },
    };
    const put = await opaAdminFetch(`${OPA}/v1/data/${PACKAGE}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    expect(put.status).toBe(204);

    const settings: GatewaySettings = {
      keycloakDiscoveryUrl:
        'http://keycloak:8080/realms/den-gateway/.well-known/openid-configuration',
      audience: 'den-gateway',
      opaUrl: 'http://opa:8181',
      accessLogUrl: 'http://fluent-bit:9880/',
      transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
      devNodes: parseDevNodes(''),
      resolveHost: () => Promise.resolve([]),
      tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'den-gateway' },
      xroad: { securityServerUrl: `http://host.docker.internal:${port}`, client: OPERATOR },
    };
    const { route, upstream } = desiredGateway(
      {
        id: randomUUID(),
        entityId: randomUUID(),
        basePath: BASE,
        upstream: { type: 'xroad', serviceId: SERVICE, servicePath: '' },
        xroadMember: { memberClass: 'GOV', memberCode: '8999999999' },
        methods: ['GET'],
        bodySubjects: [],
        hasDataSubjects: false,
        entitySlug: 'socioeconomico',
        apiName: 'M4-05',
        version: '1.0',
      },
      settings,
    );
    const plugins = { ...(route.plugins as Record<string, Record<string, unknown>>) };
    delete plugins['openid-connect'];
    delete plugins['http-logger'];
    // The renamed policy's decision, with the gateway's token like a real route (B-15).
    plugins.opa = {
      ...plugins.opa,
      policy: opaPolicy(`${PACKAGE}/authz/decision`, opaDecisionToken()),
    };
    await admin.put('routes', ROUTE, {
      uri: `${BASE}/*`,
      methods: ['GET'],
      upstream: { ...upstream, labels: undefined },
      plugins,
    });
    for (let i = 0; i < 40 && (await fetch(`${GATEWAY}${BASE}/x`)).status === 404; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  afterAll(async () => {
    await admin.delete('routes', ROUTE);
    for (const { path } of readPolicies()) {
      await opaAdminFetch(`${OPA}/v1/policies/${PACKAGE}-${path.replace(/\W/g, '-')}`, {
        method: 'DELETE',
      });
    }
    await opaAdminFetch(`${OPA}/v1/data/${PACKAGE}`, { method: 'DELETE' });
    server.close();
  });

  const call = async (headers: Record<string, string> = {}, path = '/hogares/1000000001') => {
    seen = [];
    const res = await fetch(`${GATEWAY}${BASE}${path}?campos=basico`, {
      headers: {
        authorization: `Bearer ${token(CLIENT)}`,
        'x-den-purpose': 'benefit_targeting',
        'x-den-end-user': 'funcionario-42',
        ...headers,
      },
    });
    await res.arrayBuffer();
    return { res, seen: seen[0] };
  };

  it('reaches the Security Server at /r1/{serviceId}/… as the operator subsystem', async () => {
    const { res, seen } = await call();
    expect(res.status).toBe(200);
    expect(decodeURIComponent(seen?.path ?? '')).toBe(
      '/r1/CO/GOV/8999999999/REGISTRO SOCIAL/consultaHogar/hogares/1000000001?campos=basico',
    );
    expect(seen?.headers['x-road-client']).toBe(OPERATOR);
    // X-Road response headers reach the consumer.
    expect(res.headers.get('x-road-service')).toContain('consultaHogar');
  });

  it('the policy sets X-Road-UserId (official hash) and X-Road-Issue (subscription)', async () => {
    const { seen } = await call();
    expect(seen?.headers['x-road-userid']).toBe(
      createHmac('sha256', SALT).update('funcionario-42').digest('hex'),
    );
    expect(seen?.headers['x-road-issue']).toBe(`den:subscription:${SUBSCRIPTION}`);
    expect(seen?.headers['x-den-subscription']).toBe(SUBSCRIPTION);
  });

  it('a consumer cannot steer the Security Server nor forge the X-Road headers', async () => {
    const { res, seen } = await call({
      'X-Road-Client': 'CO/GOV/666/INTRUSO',
      'X-Road-Security-Server': 'CO/GOV/666/SS-INTRUSO',
      'X-Road-Represented-Party': 'GOV/666',
      'X-Road-Id': 'id-falso',
      'X-Road-Request-Hash': 'hash-falso',
      'X-Road-UserId': 'usuario-falso',
      'X-Road-Issue': 'falso',
    });
    expect(res.status).toBe(200);
    expect(seen?.headers['x-road-client']).toBe(OPERATOR);
    for (const name of [
      'x-road-security-server',
      'x-road-represented-party',
      'x-road-id',
      'x-road-request-hash',
    ]) {
      expect(seen?.headers, name).not.toHaveProperty(name);
    }
    expect(seen?.headers['x-road-userid']).not.toBe('usuario-falso');
    expect(seen?.headers['x-road-issue']).toBe(`den:subscription:${SUBSCRIPTION}`);
  });

  it('a path trick cannot change the serviceId', async () => {
    const { seen } = await call({}, '/hogares/..%2F..%2F..%2FOTRO%2FSERVICIO');
    if (seen) expect(decodeURIComponent(seen.path)).toContain('/r1/CO/GOV/8999999999/');
  });

  it('a denied call never reaches the Security Server', async () => {
    seen = [];
    const res = await fetch(`${GATEWAY}${BASE}/hogares/1`, {
      headers: { authorization: `Bearer ${token('den-app-otra')}`, 'x-den-purpose': 'x' },
    });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
