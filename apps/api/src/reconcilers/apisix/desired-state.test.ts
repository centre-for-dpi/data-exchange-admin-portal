import { describe, expect, it } from 'vitest';
import {
  deprecationHeaders,
  desiredGateway,
  type GatewaySettings,
  matches,
  parseDevNodes,
  parseHostPort,
  TRANSPARENCY_LOG_FORMAT,
  UnsupportedUpstreamError,
  type VersionForGateway,
  desiredSsl,
  gatewayClientName,
  gatewayClientSslId,
  needsGatewayPki,
  parseHostNames,
  usesGatewayClientCertificate,
  sslMatches,
} from './desired-state.js';

const settings: GatewaySettings = {
  keycloakDiscoveryUrl: 'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
  audience: 'rid-gateway',
  opaUrl: 'http://opa:8181',
  accessLogUrl: 'http://fluent-bit:9880/',
  transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
  devNodes: parseDevNodes('salud=mock-salud:8000'),
  resolveHost: () => Promise.resolve(['93.184.215.14']),
  tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'rid-gateway' },
};

const PROVIDER = '0190d0c4-0000-7000-8000-00000000e001';

const version = (overrides: Partial<VersionForGateway> = {}): VersionForGateway => ({
  id: '0190d0c4-0000-7000-8000-000000000001',
  entityId: PROVIDER,
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
      'rid-client-cert',
    ]);
    // The client never chooses the certificate thumbprint OPA reads, nor the provider sees it.
    expect(plugins['rid-client-cert']).toEqual({});
    expect(plugins['proxy-rewrite']?.headers).not.toMatchObject({
      remove: expect.arrayContaining(['X-RID-Client-Cert-S256']) as unknown,
    });
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
    for (const header of [
      'X-RID-Subject-Ref',
      'X-RID-End-User',
      'X-RID-Body-Subject',
      'X-RID-Client-Cert-S256',
    ]) {
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

  it('reaches a direct upstream over verified HTTPS, pinned to the addresses checked', () => {
    const { route, upstream } = desiredGateway(
      version({
        upstream: { type: 'direct', url: 'https://api.salud.example/v2/', mtls: false },
        addresses: ['93.184.215.14', '2606:2800:21f:cb07::1', '93.184.215.14'],
      }),
      settings,
    );
    expect(upstream).toMatchObject({
      scheme: 'https',
      // The name stays as Host and SNI; the certificate must be valid for it.
      pass_host: 'rewrite',
      upstream_host: 'api.salud.example',
      nodes: { '[2606:2800:21f:cb07::1]:443': 1, '93.184.215.14:443': 1 },
      tls: { verify: true },
    });
    expect(upstream.tls).not.toHaveProperty('client_cert_id');
    expect((route.plugins as Plugins)['proxy-rewrite']?.regex_uri).toEqual([
      '^/salud/afiliacion/v1/(.*)$',
      '/v2/$1',
    ]);
  });

  it('presents the gateway client certificate to a direct upstream that requires mTLS (M3-03)', () => {
    const { upstream } = desiredGateway(
      version({
        upstream: { type: 'direct', url: 'https://api.salud.example:8443', mtls: true },
        addresses: ['93.184.215.14'],
      }),
      settings,
    );
    expect(upstream).toMatchObject({
      nodes: { '93.184.215.14:8443': 1 },
      tls: { verify: true, client_cert_id: gatewayClientSslId(PROVIDER) },
    });
    expect(usesGatewayClientCertificate(upstream)).toBe(true);
    // Each provider gets its own gateway identity: another entity's route pointed at this API
    // presents another name (no confused deputy).
    const other = desiredGateway(
      version({
        entityId: '0190d0c4-0000-7000-8000-00000000e002',
        upstream: { type: 'direct', url: 'https://api.salud.example:8443', mtls: true },
        addresses: ['93.184.215.14'],
      }),
      settings,
    ).upstream;
    expect((other.tls as { client_cert_id: string }).client_cert_id).not.toBe(
      gatewayClientSslId(PROVIDER),
    );
    expect(gatewayClientName(settings, 'salud')).toBe('rid-gateway.salud');
    expect(
      needsGatewayPki({ type: 'direct', url: 'https://a.example', mtls: true }, 'salud', settings),
    ).toBe(true);
    expect(
      needsGatewayPki({ type: 'direct', url: 'https://a.example', mtls: false }, 'salud', settings),
    ).toBe(false);
  });

  it('calls a TLS node with mTLS, verifying it against the network CA (M3-03)', () => {
    const tlsSettings = { ...settings, devNodes: parseDevNodes('salud=https://mock-salud:8443') };
    const ca = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
    const { upstream } = desiredGateway(version(), tlsSettings, { networkCaPem: `${ca}${ca}` });
    expect(upstream).toMatchObject({
      scheme: 'https',
      pass_host: 'rewrite',
      upstream_host: 'mock-salud',
      nodes: { 'mock-salud:8443': 1 },
      tls: { client_cert_id: gatewayClientSslId(PROVIDER), verify: true, ca_certs: [ca, ca] },
    });
    expect(needsGatewayPki({ type: 'node', servicePath: '/s' }, 'salud', tlsSettings)).toBe(true);
    expect(needsGatewayPki({ type: 'node', servicePath: '/s' }, 'salud', settings)).toBe(false);
    // Without the network CA it cannot verify the node: no half-configured upstream.
    expect(() => desiredGateway(version(), tlsSettings)).toThrow(UnsupportedUpstreamError);
  });

  it('fails closed on what the gateway cannot do yet', () => {
    const cases: Array<Partial<VersionForGateway>> = [
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
    expect([
      ...parseDevNodes('salud=mock-salud:8000, x=bad, =a:1,socio=https://Mock-Socio:8443'),
    ]).toEqual([
      ['salud', { host: 'mock-salud', hostPort: 'mock-salud:8000', tls: false }],
      ['socio', { host: 'mock-socio', hostPort: 'mock-socio:8443', tls: true }],
    ]);
  });
});

describe('deprecated versions (ADR-0019)', () => {
  const deprecation = {
    deprecatedAt: new Date('2026-11-13T12:00:00Z'),
    sunsetAt: new Date('2027-03-01T00:00:00Z'),
  };

  it('announce Deprecation (RFC 9745) and Sunset (RFC 8594) on every response', () => {
    expect(deprecationHeaders(deprecation)).toEqual({
      Deprecation: '@1794571200',
      Sunset: 'Mon, 01 Mar 2027 00:00:00 GMT',
    });
    const { route } = desiredGateway(version({ deprecation }), settings);
    expect((route.plugins as Record<string, unknown>)['response-rewrite']).toEqual({
      headers: { set: deprecationHeaders(deprecation) },
    });
  });

  it('leave published versions without the headers', () => {
    const { route } = desiredGateway(version(), settings);
    expect(route.plugins).not.toHaveProperty('response-rewrite');
  });
});

describe('gateway TLS (M3-02)', () => {
  const certificate = {
    hosts: ['gw.example.org', 'localhost'],
    certificatePem: 'CERT',
    keyPem: 'KEY',
    networkCaPem: 'CA',
  };

  it('serves the server certificate on the gateway names; client CA only with mTLS', () => {
    const plain = desiredSsl(certificate, settings);
    expect(plain).toMatchObject({ type: 'server', snis: ['gw.example.org', 'localhost'] });
    expect(plain).not.toHaveProperty('client');
    const mtls = desiredSsl(certificate, {
      ...settings,
      tls: { ...settings.tls, mtlsRequired: true },
    });
    expect(mtls.client).toEqual({ ca: 'CA', depth: 2 });
    expect(mtls).not.toHaveProperty('client.skip_mtls_uri_regex');
  });

  it('ignores the stored (encrypted) key but notices a client CA left behind', () => {
    const desired = desiredSsl(certificate, settings);
    const stored = { ...desired, key: 'encrypted-by-apisix', validity_end: 1 };
    expect(sslMatches(desired, stored)).toBe(true);
    expect(sslMatches(desired, { ...stored, client: { ca: 'CA', depth: 2 } })).toBe(false);
    expect(sslMatches(desired, { ...stored, cert: 'OTHER' })).toBe(false);
  });

  it('parses the gateway host names', () => {
    expect(parseHostNames(' GW.example.org , localhost,gw.example.org')).toEqual([
      'gw.example.org',
      'localhost',
    ]);
    expect(() => parseHostNames('bad_name')).toThrow();
    expect(() => parseHostNames(' , ')).toThrow();
  });
});
