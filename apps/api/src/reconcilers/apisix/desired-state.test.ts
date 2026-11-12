import { describe, expect, it } from 'vitest';
import {
  desiredGateway,
  type GatewaySettings,
  matches,
  parseDevNodes,
  UnsupportedUpstreamError,
  type VersionForGateway,
} from './desired-state.js';

const settings: GatewaySettings = {
  keycloakDiscoveryUrl: 'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
  audience: 'rid-gateway',
  opaUrl: 'http://opa:8181',
  accessLogUrl: 'http://fluent-bit:9880/',
  devNodes: parseDevNodes('salud=mock-salud:8000'),
};

const version = (overrides: Partial<VersionForGateway> = {}): VersionForGateway => ({
  id: '0190d0c4-0000-7000-8000-000000000001',
  basePath: '/salud/afiliacion/v1',
  upstream: { type: 'node', servicePath: '/salud' },
  methods: ['get', 'POST', 'GET'],
  entitySlug: 'salud',
  apiName: 'Consulta de afiliación',
  version: '1.0',
  ...overrides,
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
    expect(removed).not.toContain('X-RID-Purpose');
    expect(removed).not.toContain('X-RID-End-User');
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
