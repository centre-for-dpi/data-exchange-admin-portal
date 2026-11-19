import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { readPolicies } from '../opa/policy-files.js';
import { HttpApisixAdmin } from '../reconcilers/apisix/apisix-admin.js';
import { opaAdminFetch, opaDecisionToken } from '../../test/opa.js';
import {
  desiredGateway,
  type GatewaySettings,
  opaPolicy,
  parseDevNodes,
} from '../reconcilers/apisix/desired-state.js';
import { AccessLogIndexReconciler } from './access-log-index.js';
import { HttpOpenSearch, openSearchUrl } from './opensearch.js';

const GATEWAY = `http://127.0.0.1:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
// den- so the access-log filter keeps it, test- so no reconciler manages it.
const ROUTE = 'den-test-m5-01-access-log';
const PACKAGE = 'dentestm501';
const BASE = '/__den_m5_01__/afiliacion/v1';
const CLIENT = 'den-app-m5-01';
const SUBSCRIPTION = '0190d0c4-0000-7000-8000-00000000a501';
const DOCUMENT = '1000000001';

/** The fields an access-log document may have (ARCHITECTURE.md §8), plus Fluent Bit's time. */
const ALLOWED = new Set([
  '@timestamp',
  'ts',
  'request_id',
  'route_id',
  'operation',
  'method',
  'status',
  'latency_ms',
  'upstream_latency_ms',
  'consumer_entity',
  'consumer_app',
  'subscription_id',
  'purpose',
  'end_user_hash',
  'bytes_sent',
  'gateway_node',
  'deny_reason',
]);

const token = (azp: string) =>
  [{ alg: 'none', typ: 'JWT' }, { azp }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')
    .concat('.');

type Doc = Record<string, unknown>;

/**
 * M5-01, the whole pipeline: APISIX's http-logger with the reconciler's log format → Fluent Bit
 * with the allowlist → OpenSearch with the strict template. Calls carry the identification
 * number in the path and in the query; no indexed document may contain either. Against the real
 * stack with the observability profile (pnpm infra:up), the real policy under a test package and
 * a provider on the host; only openid-connect is left out (the policy decodes the token).
 */
describe('access logs reach OpenSearch with metadata only (M5-01)', () => {
  const prisma = new PrismaService();
  const openSearch = new HttpOpenSearch(openSearchUrl());
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  let provider: Server;
  // Letters only: the pipeline drops a consumer-written request id with six digits in a row (M-16),
  // which eight hex characters of a UUID contain about one run in ten.
  const run = randomUUID()
    .slice(0, 8)
    .replace(/\d/g, (digit) => 'ghijklmnop'[Number(digit)] ?? 'x');

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
    await new AccessLogIndexReconciler(prisma, openSearch).reconcileTemplate();
    provider = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(`{"numeroIdentificacion":"${DOCUMENT}","regimen":"contributivo"}`);
    });
    await new Promise<void>((resolve) => provider.listen(0, '0.0.0.0', () => resolve()));
    const port = (provider.address() as AddressInfo).port;

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
    const put = await opaAdminFetch(`${OPA}/v1/data/${PACKAGE}`, {
      method: 'PUT',
      body: JSON.stringify({
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
          endUserHashSalt: 'm5-01-end-user-salt-0123456789',
          subjectRefKey: 'm5-01-subject-ref-key-0123456789abcdef',
          country: 'CO',
          documentTypes: ['CC'],
          documentNumberFormats: { CC: '^[1-9][0-9]{2,9}$' },
          mtlsRequired: false,
          gatewayNodes: 1,
        },
      }),
    });
    expect(put.status).toBe(204);

    // The route as the reconciler writes it, with its http-logger.
    const { route } = desiredGateway(
      {
        id: randomUUID(),
        entityId: randomUUID(),
        basePath: BASE,
        upstream: { type: 'node', servicePath: '/servicio' },
        methods: ['GET'],
        bodySubjects: [],
        hasDataSubjects: false,
        entitySlug: 'salud',
        apiName: 'M5-01',
        version: '1.0',
      },
      settings,
    );
    const plugins = { ...(route.plugins as Record<string, Record<string, unknown>>) };
    delete plugins['openid-connect'];
    expect(plugins).toHaveProperty('http-logger');
    // The renamed policy's decision, with the gateway's token like a real route (B-15).
    plugins.opa = {
      ...plugins.opa,
      policy: opaPolicy(`${PACKAGE}/authz/decision`, opaDecisionToken()),
    };
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
      await opaAdminFetch(`${OPA}/v1/policies/${PACKAGE}-${path.replace(/\W/g, '-')}`, {
        method: 'DELETE',
      });
    }
    await opaAdminFetch(`${OPA}/v1/data/${PACKAGE}`, { method: 'DELETE' });
    provider.close();
    await prisma.$disconnect();
  });

  const call = async (requestId: string, headers: Record<string, string>) => {
    const res = await fetch(
      `${GATEWAY}${BASE}/afiliados/${DOCUMENT}?documento=${DOCUMENT}&tipo=CC`,
      {
        headers: {
          authorization: `Bearer ${token(CLIENT)}`,
          'x-request-id': requestId,
          ...headers,
        },
      },
    );
    await res.arrayBuffer();
    return res.status;
  };

  /** The documents of these request ids, once Fluent Bit flushed them and OpenSearch refreshed. */
  async function indexed(ids: string[]): Promise<Doc[]> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const res = await openSearch.request<{ hits?: { hits: Array<{ _source: Doc }> } }>(
        'POST',
        '/den-access-*/_search',
        { size: 10, query: { terms: { request_id: ids } } },
      );
      const hits = res.body.hits?.hits ?? [];
      if (hits.length >= ids.length) return hits.map((h) => h._source);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`access logs of ${ids.join(', ')} never reached OpenSearch`);
  }

  it('an allowed and a denied call are indexed with metadata only', async () => {
    const allowedId = `m5-01-allowed-${run}`;
    const deniedId = `m5-01-denied-${run}`;
    expect(
      await call(allowedId, {
        'x-den-purpose': 'eligibility_check',
        'x-den-end-user': 'funcionario-42',
      }),
    ).toBe(200);
    expect(await call(deniedId, { 'x-den-purpose': 'benefit_targeting' })).toBe(403);

    const docs = await indexed([allowedId, deniedId]);
    for (const doc of docs) {
      expect(Object.keys(doc).filter((key) => !ALLOWED.has(key))).toEqual([]);
      const text = JSON.stringify(doc);
      expect(text).not.toContain(DOCUMENT);
      expect(text).not.toContain('afiliados');
      expect(text).not.toContain('documento');
    }
    const allowed = docs.find((d) => d.request_id === allowedId);
    expect(allowed).toMatchObject({
      route_id: ROUTE,
      operation: 'getAfiliado',
      method: 'GET',
      status: 200,
      consumer_entity: 'programas-sociales',
      consumer_app: CLIENT,
      subscription_id: SUBSCRIPTION,
      purpose: 'eligibility_check',
    });
    expect(typeof allowed?.latency_ms).toBe('number');
    expect(typeof allowed?.upstream_latency_ms).toBe('number');
    expect(allowed?.end_user_hash).toMatch(/^[0-9a-f]{64}$/);
    // The denial, attributed to the application that made it, with its reason.
    expect(docs.find((d) => d.request_id === deniedId)).toMatchObject({
      status: 403,
      deny_reason: 'purpose_not_allowed',
      consumer_app: CLIENT,
      consumer_entity: 'programas-sociales',
    });
  });

  it('no indexed document anywhere contains the identification number', async () => {
    const sneakyId = `m5-01-sneaky-${run}`;
    // A purpose with the number in it: free text where a code goes.
    await call(sneakyId, { 'x-den-purpose': `cedula ${DOCUMENT}` });
    const [doc] = await indexed([sneakyId]);
    expect(doc).not.toHaveProperty('purpose');
    const res = await openSearch.request<{ hits: { total: { value: number } } }>(
      'POST',
      '/den-access-*/_search',
      {
        size: 0,
        query: { query_string: { query: `*${DOCUMENT}*`, default_field: '*', lenient: true } },
      },
    );
    expect(res.body.hits.total.value).toBe(0);
  });
});
