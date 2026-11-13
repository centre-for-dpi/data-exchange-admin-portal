import { describe, expect, it } from 'vitest';
import {
  desiredGateway,
  type GatewaySettings,
  matches,
  parseDevNodes,
  parseHostPort,
  TRANSPARENCY_LOG_FORMAT,
  UnsupportedUpstreamError,
  type VersionForGateway,
} from './desired-state.js';

const settings: GatewaySettings = {
  keycloakDiscoveryUrl: 'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
  audience: 'rid-gateway',
  opaUrl: 'http://opa:8181',
  accessLogUrl: 'http://fluent-bit:9880/',
  transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
  devNodes: parseDevNodes('salud=mock-salud:8000'),
  resolveHost: () => Promise.resolve(['93.184.215.14']),
};

const version = (overrides: Partial<VersionForGateway> = {}): VersionForGateway => ({
  id: '0190d0c4-0000-7000-8000-000000000001',
  basePath: '/salud/afiliacion/v1',
  upstream: { type: 'node', servicePath: '/salud' },
  methods: ['get', 'POST', 'GET'],
  bodySubjects: [],
  hasDataSubjects: false,
  entitySlug: 'salud',
  apiName: 'Consulta de afiliación',
  version: '1.0',
  ...overrides,
});

describe('data subject read from the body (ADR-0017)', () => {
  it('adds rid-data-subject only to routes with body subjects', () => {
    const without = desiredGateway(version(), settings).route.plugins as Plugins;
    expect(without).not.toHaveProperty('rid-data-subject');

    const plugins = desiredGateway(
      version({
        bodySubjects: [
          {
            method: 'post',
            pathRegex: '^/salud/afiliacion/v1/afiliados/verificaciones$',
            pointer: '/numeroIdentificacion',
          },
          { method: 'POST', pathRegex: '^/x$', pointer: '/n', typePointer: '/t' },
        ],
      }),
      settings,
    ).route.plugins as Plugins;
    expect(plugins['rid-data-subject']).toEqual({
      operations: [
        {
          method: 'POST',
          uri: '^/salud/afiliacion/v1/afiliados/verificaciones$',
          pointer: '/numeroIdentificacion',
        },
        { method: 'POST', uri: '^/x$', pointer: '/n', type_pointer: '/t' },
      ],
    });
    // OPA reads what the plugin extracted and never returns it: it does not reach the provider.
    expect(plugins.opa?.send_headers_upstream).toContain('X-RID-Body-Subject');
    // proxy-rewrite runs after the plugin and must not remove its value.
    const removed = (plugins['proxy-rewrite']?.headers as { remove: string[] }).remove;
    expect(removed).not.toContain('X-RID-Body-Subject');
  });
});

type Plugins = Record<string, Record<string, unknown>>;

describe('desired APISIX state (ARCHITECTURE.md §4.1)', () => {
  it('routes the public base path to the node service path, with deterministic ids', () => {
    const { route, upstream } = desiredGateway(version(), settings);
    expect(route).toMatchObject({
      uri: '/salud/afiliacion/v1/*',
      methods: ['GET', 'POST'],
      upstream_id: 'rid-upstream-0190d0c4-0000-7000-8000-000000000001',
      status: 1,
    });
    expect(upstream).toMatchObject({ scheme: 'http', nodes: { 'mock-salud:8000': 1 } });
    const plugins = route.plugins as Plugins;
    expect(plugins['proxy-rewrite']?.regex_uri).toEqual([
      '^/salud/afiliacion/v1/(.*)$',
      '/salud/$1',
    ]);
  });

  it('applies the plugin chain: request id, token for the gateway, header cleanup, OPA, logs', () => {
    const plugins = desiredGateway(version(), settings).route.plugins as Plugins;
    expect(Object.keys(plugins).sort()).toEqual([
      'http-logger',
      'opa',
      'openid-connect',
      'prometheus',
      'proxy-rewrite',
      'request-id',
    ]);
    expect(plugins['openid-connect']).toMatchObject({
      client_id: 'rid-gateway',
      bearer_only: true,
      use_jwks: true,
      set_access_token_header: false,
      claim_validator: { audience: { required: true, match_with_client_id: true } },
    });
    expect(plugins.opa).toMatchObject({ policy: 'rid/authz', with_route: true });
    // Clients cannot forge gateway headers; purpose and end user stay for OPA to read.
    const removed = (plugins['proxy-rewrite']?.headers as { remove: string[] }).remove;
    expect(removed).toContain('X-RID-Subscription');
    expect(removed).toContain('X-RID-Subject-Ref');
    expect(removed).not.toContain('X-RID-Purpose');
    expect(removed).not.toContain('X-RID-End-User');
    expect(removed).not.toContain('X-RID-Body-Subject');
    // OPA decides these; the clear official and data subject are listed and never returned.
    const decided = plugins.opa?.send_headers_upstream as string[];
    for (const header of ['X-RID-Subject-Ref', 'X-RID-End-User', 'X-RID-Body-Subject']) {
      expect(decided).toContain(header);
    }
  });

  it('logs metadata only: never the real path, query or body (ARCHITECTURE.md §8)', () => {
    const logger = (desiredGateway(version(), settings).route.plugins as Plugins)['http-logger'];
    expect(logger).toMatchObject({ include_req_body: false, include_resp_body: false });
    const values = Object.values(logger?.log_format as Record<string, string>);
    for (const forbidden of [
      '$uri',
      '$request_uri',
      '$upstream_uri',
      '$args',
      '$http_authorization',
      // Analytics never learn whose data was consulted (ADR-0015).
      '$http_x_rid_subject_ref',
      '$http_x_rid_data_subject',
    ]) {
      expect(values).not.toContain(forbidden);
    }
  });

  it('reaches a direct upstream over HTTPS with its path prefix', () => {
    const { route, upstream } = desiredGateway(
      version({ upstream: { type: 'direct', url: 'https://api.salud.example/v2/', mtls: false } }),
      settings,
    );
    expect(upstream).toMatchObject({
      scheme: 'https',
      pass_host: 'node',
      nodes: { 'api.salud.example:443': 1 },
    });
    expect((route.plugins as Plugins)['proxy-rewrite']?.regex_uri).toEqual([
      '^/salud/afiliacion/v1/(.*)$',
      '/v2/$1',
    ]);
  });

  it('fails closed on what the gateway cannot do yet', () => {
    const cases: Array<Partial<VersionForGateway>> = [
      { upstream: { type: 'direct', url: 'https://api.salud.example', mtls: true } },
      { upstream: { type: 'node', servicePath: '/salud', nodeId: crypto.randomUUID() } },
      { entitySlug: 'socioeconomico' },
      // Never proxy towards the platform's own network (SSRF).
      { upstream: { type: 'direct', url: 'https://keycloak:8443/admin', mtls: false } },
      { upstream: { type: 'direct', url: 'https://169.254.169.254', mtls: false } },
    ];
    for (const overrides of cases) {
      expect(() => desiredGateway(version(overrides), settings)).toThrow(UnsupportedUpstreamError);
    }
  });
});

describe('transparency register (ADR-0015, MT-03)', () => {
  it('logs calls of routes with data subjects to their own pipeline, never the path', () => {
    const without = desiredGateway(version(), settings).route.plugins as Plugins;
    expect(without).not.toHaveProperty('tcp-logger');

    const plugins = desiredGateway(version({ hasDataSubjects: true }), settings).route
      .plugins as Plugins;
    expect(plugins['tcp-logger']).toMatchObject({
      host: 'fluent-bit-transparency',
      port: 5170,
      include_req_body: false,
      include_resp_body: false,
      log_format: TRANSPARENCY_LOG_FORMAT,
    });
    const variables = Object.values(TRANSPARENCY_LOG_FORMAT).join(' ');
    // Nothing that carries the path, the query, bodies or the clear data subject.
    for (const forbidden of ['$uri', '$request_uri', '$upstream_uri', '$args', '$request_body']) {
      expect(variables).not.toContain(forbidden);
    }
    expect(variables).not.toMatch(/body_subject|data_subject/);
    // The official only as their keyed hash, never X-RID-End-User in clear.
    expect(Object.values(TRANSPARENCY_LOG_FORMAT)).not.toContain('$http_x_rid_end_user');
    // The idempotency key is nginx's own id, not the client-chosen X-Request-Id.
    expect(TRANSPARENCY_LOG_FORMAT.gateway_request_id).toBe('$request_id');
    // The analytics log stays without the data subject.
    expect(JSON.stringify(plugins['http-logger'])).not.toContain('subject');
  });
});

describe('parseHostPort', () => {
  it('reads host:port and rejects anything else', () => {
    expect(parseHostPort(' fluent-bit-transparency:5170 ')).toEqual({
      host: 'fluent-bit-transparency',
      port: 5170,
    });
    for (const bad of ['fluent-bit', 'host:0', 'host:70000', 'http://host:1', ':5170']) {
      expect(() => parseHostPort(bad)).toThrow();
    }
  });
});

describe('matches', () => {
  it('accepts defaults APISIX adds but not changed or missing fields', () => {
    const desired = { a: 1, plugins: { opa: { policy: 'rid/authz' } }, methods: ['GET'] };
    expect(
      matches(desired, {
        ...desired,
        create_time: 1,
        plugins: { opa: { policy: 'rid/authz', timeout: 3000 } },
      }),
    ).toBe(true);
    expect(matches(desired, { ...desired, plugins: {} })).toBe(false);
    expect(matches(desired, { ...desired, methods: ['GET', 'POST'] })).toBe(false);
    expect(matches(desired, { ...desired, a: 2 })).toBe(false);
  });
});

describe('parseDevNodes', () => {
  it('reads slug=host:port pairs and ignores malformed ones', () => {
    expect([...parseDevNodes('salud=mock-salud:8000, x=bad, =a:1,socio=mock-socio:8001')]).toEqual([
      ['salud', 'mock-salud:8000'],
      ['socio', 'mock-socio:8001'],
    ]);
  });
});
