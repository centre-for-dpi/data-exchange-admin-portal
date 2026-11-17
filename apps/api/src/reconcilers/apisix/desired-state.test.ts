import { describe, expect, it } from 'vitest';
import {
  desiredNodeControlRoute,
  desiredTokenRoute,
  NODE_ONLY_SKIP_MTLS_REGEX,
  deprecationHeaders,
  desiredGateway,
  devNodeOf,
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
  keycloakDiscoveryUrl: 'http://keycloak:8080/realms/den-gateway/.well-known/openid-configuration',
  audience: 'den-gateway',
  opaUrl: 'http://opa:8181',
  accessLogUrl: 'http://fluent-bit:9880/',
  transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
  devNodes: parseDevNodes('salud=mock-salud:8000'),
  resolveHost: () => Promise.resolve(['93.184.215.14']),
  tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'den-gateway' },
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
  it('adds den-data-subject only to routes with body subjects', () => {
    const without = desiredGateway(version(), settings).route.plugins as Plugins;
    expect(without).not.toHaveProperty('den-data-subject');

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
    expect(plugins['den-data-subject']).toEqual({
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
    expect(plugins.opa?.send_headers_upstream).toContain('X-DEN-Body-Subject');
    // proxy-rewrite runs after the plugin and must not remove its value.
    const removed = (plugins['proxy-rewrite']?.headers as { remove: string[] }).remove;
    expect(removed).not.toContain('X-DEN-Body-Subject');
  });
});

type Plugins = Record<string, Record<string, unknown>>;

describe('desired APISIX state (ARCHITECTURE.md §4.1)', () => {
  it('routes the public base path to the node service path, with deterministic ids', () => {
    const { route, upstream } = desiredGateway(version(), settings);
    expect(route).toMatchObject({
      uri: '/salud/afiliacion/v1/*',
      methods: ['GET', 'POST'],
      upstream_id: 'den-upstream-0190d0c4-0000-7000-8000-000000000001',
      status: 1,
    });
    expect(upstream).toMatchObject({ scheme: 'http', nodes: { 'mock-salud:8000': 1 } });
    const plugins = route.plugins as Plugins;
    expect(plugins['proxy-rewrite']?.regex_uri).toEqual([
      '^/salud/afiliacion/v1/(.*)$',
      '/salud/$1',
    ]);
  });

  it('signs for the provider entity when the country turns the assertion on (M6-10)', () => {
    const off = desiredGateway(version(), settings).route.plugins as Plugins;
    expect(off['den-assertion']).toBeUndefined();
    const on = desiredGateway(version(), {
      ...settings,
      assertion: { issuer: 'https://gw.example' },
    }).route.plugins as Plugins;
    expect(on['den-assertion']).toEqual({ audience: 'salud' });
  });

  it('applies the plugin chain: request id, token for the gateway, header cleanup, OPA, logs', () => {
    const plugins = desiredGateway(version(), settings).route.plugins as Plugins;
    expect(Object.keys(plugins).sort()).toEqual([
      'den-client-cert',
      'den-header-guard',
      'den-rate-limited',
      'http-logger',
      'limit-count',
      'opa',
      'openid-connect',
      'prometheus',
      'proxy-rewrite',
      'request-id',
    ]);
    expect(plugins['den-header-guard']).toEqual({});
    // Per-subscription limit (S-2): from OPA's headers, counted on each node.
    expect(plugins['limit-count']).toMatchObject({
      count: '$http_x_den_rate_limit',
      key_type: 'var',
      key: 'http_x_den_subscription',
      time_window: 60,
      policy: 'local',
      rejected_code: 429,
    });
    expect(plugins.opa?.send_headers_upstream as string[]).toContain('X-DEN-Rate-Limit');
    // The client never chooses the certificate thumbprint OPA reads, nor the provider sees it.
    expect(plugins['den-client-cert']).toEqual({});
    expect(plugins['proxy-rewrite']?.headers).not.toMatchObject({
      remove: expect.arrayContaining(['X-DEN-Client-Cert-S256']) as unknown,
    });
    expect(plugins['openid-connect']).toMatchObject({
      client_id: 'den-gateway',
      bearer_only: true,
      use_jwks: true,
      set_access_token_header: false,
      claim_validator: { audience: { required: true, match_with_client_id: true } },
    });
    expect(plugins.opa).toMatchObject({
      policy: 'den/authz/decision',
      with_route: true,
      keepalive: true,
      keepalive_pool: 64,
    });
    // Clients cannot forge gateway headers; purpose and end user stay for OPA to read.
    const removed = (plugins['proxy-rewrite']?.headers as { remove: string[] }).remove;
    expect(removed).toContain('X-DEN-Subscription');
    expect(removed).toContain('X-DEN-Subject-Ref');
    expect(removed).not.toContain('X-DEN-Purpose');
    expect(removed).not.toContain('X-DEN-End-User');
    expect(removed).not.toContain('X-DEN-Body-Subject');
    // OPA decides these; the clear official and data subject are listed and never returned.
    const decided = plugins.opa?.send_headers_upstream as string[];
    for (const header of [
      'X-DEN-Subject-Ref',
      'X-DEN-End-User',
      'X-DEN-Body-Subject',
      'X-DEN-Client-Cert-S256',
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
      '$http_x_den_subject_ref',
      '$http_x_den_data_subject',
      '$http_x_den_body_subject',
      // The official only as its salted hash (M3-06).
      '$http_x_den_end_user',
    ]) {
      expect(values).not.toContain(forbidden);
    }
    expect(values).toContain('$http_x_den_end_user_hash');
  });

  it('the transparency record carries the official only as its salted hash (M3-06)', () => {
    const values = Object.values(TRANSPARENCY_LOG_FORMAT);
    for (const forbidden of [
      '$http_x_den_end_user',
      '$http_x_den_body_subject',
      '$http_x_den_data_subject',
      '$uri',
      '$request_uri',
      '$args',
    ]) {
      expect(values).not.toContain(forbidden);
    }
    expect(values).toContain('$http_x_den_end_user_hash');
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

  describe('a version consumed through X-Road (M4-05, SPIKE S-5)', () => {
    const serviceId = {
      instance: 'CO',
      memberClass: 'GOV',
      memberCode: '8999999999',
      serviceCode: 'consultaHogar',
    };
    const xroadSettings = {
      ...settings,
      xroad: { securityServerUrl: 'https://ss.and.example:8443', client: 'CO/GOV/1/DEN' },
    };
    const onXroad = (member: VersionForGateway['xroadMember']) =>
      version({ upstream: { type: 'xroad', serviceId, servicePath: '/v1' }, xroadMember: member });

    it('goes to the operator Security Server with the serviceId path and the X-Road client', () => {
      const { upstream, route } = desiredGateway(
        onXroad({ memberClass: 'GOV', memberCode: '8999999999' }),
        xroadSettings,
      );
      expect(upstream).toMatchObject({
        scheme: 'https',
        nodes: { 'ss.and.example:8443': 1 },
        upstream_host: 'ss.and.example',
        tls: { verify: true, client_cert_id: 'den-ssl-gateway-xroad' },
      });
      const plugins = route.plugins as Plugins;
      expect(plugins['proxy-rewrite']).toMatchObject({
        regex_uri: ['^/salud/afiliacion/v1/(.*)$', '/r1/CO/GOV/8999999999/consultaHogar/v1/$1'],
        headers: { set: { 'X-Road-Client': 'CO/GOV/1/DEN' } },
      });
      expect((plugins.opa as { send_headers_upstream: string[] }).send_headers_upstream).toEqual(
        expect.arrayContaining(['X-Road-UserId', 'X-Road-Issue']),
      );
    });

    it('fails closed for another member, no member, or no Security Server configured', () => {
      for (const member of [null, { memberClass: 'GOV', memberCode: '1' }]) {
        expect(() => desiredGateway(onXroad(member), xroadSettings)).toThrow(
          UnsupportedUpstreamError,
        );
      }
      expect(() =>
        desiredGateway(onXroad({ memberClass: 'GOV', memberCode: '8999999999' }), settings),
      ).toThrow(UnsupportedUpstreamError);
    });

    it('fails closed for a path that could leave the serviceId, or another instance', () => {
      const member = { memberClass: 'GOV', memberCode: '8999999999' };
      for (const upstream of [
        { type: 'xroad' as const, serviceId, servicePath: '/../../OTRO' },
        { type: 'xroad' as const, serviceId: { ...serviceId, serviceCode: '..' }, servicePath: '' },
        { type: 'xroad' as const, serviceId: { ...serviceId, instance: 'EE' }, servicePath: '' },
      ]) {
        expect(
          () => desiredGateway(version({ upstream, xroadMember: member }), xroadSettings),
          JSON.stringify(upstream),
        ).toThrow(UnsupportedUpstreamError);
      }
    });

    it('other routes carry no X-Road header', () => {
      const plugins = desiredGateway(version(), settings).route.plugins as Plugins;
      expect(JSON.stringify(plugins)).not.toContain('X-Road');
    });
  });

  describe('a version on an enrolled kit node (M4-04, ADR-0023)', () => {
    const NODE = '0190d0c4-0000-7000-8000-00000000a0de';
    const pki = {
      networkCaPem: ['-----BEGIN CERTIFICATE-----', 'AA', '-----END CERTIFICATE-----', ''].join(
        '\n',
      ),
    };
    const onNode = (node: VersionForGateway['node']) =>
      version({ upstream: { type: 'node', nodeId: NODE, servicePath: '/salud/' }, node });
    const hubSettings = { ...settings, wgHub: 'wg-hub:8443' };

    it('goes to the hub with the node name as SNI, mTLS and the network CA', () => {
      const { upstream, route } = desiredGateway(
        onNode({ id: NODE, entityId: PROVIDER, status: 'online' }),
        hubSettings,
        pki,
      );
      expect(upstream).toMatchObject({
        scheme: 'https',
        nodes: { 'wg-hub:8443': 1 },
        pass_host: 'rewrite',
        upstream_host: `den-node-${NODE}`,
        tls: {
          verify: true,
          client_cert_id: gatewayClientSslId(PROVIDER),
          ca_certs: [pki.networkCaPem],
        },
      });
      // The service path on the node, without its trailing slash.
      expect((route.plugins as Plugins)['proxy-rewrite']).toMatchObject({
        regex_uri: ['^/salud/afiliacion/v1/(.*)$', '/salud/$1'],
      });
      expect(needsGatewayPki(onNode(null).upstream, 'salud', hubSettings)).toBe(true);
    });

    it('keeps an offline node: it answers again when it reports back', () => {
      expect(() =>
        desiredGateway(
          onNode({ id: NODE, entityId: PROVIDER, status: 'offline' }),
          hubSettings,
          pki,
        ),
      ).not.toThrow();
    });

    it('never calls a node of another entity, one not enrolled, or a decommissioned one', () => {
      for (const node of [
        null,
        { id: NODE, entityId: '0190d0c4-0000-7000-8000-00000000e002', status: 'online' },
        { id: NODE, entityId: PROVIDER, status: 'enrollment_issued' },
        { id: NODE, entityId: PROVIDER, status: 'decommissioned' },
      ]) {
        expect(() => desiredGateway(onNode(node), hubSettings, pki), JSON.stringify(node)).toThrow(
          UnsupportedUpstreamError,
        );
      }
    });

    it('needs the hub and the network CA', () => {
      const node = { id: NODE, entityId: PROVIDER, status: 'online' };
      expect(() => desiredGateway(onNode(node), settings, pki)).toThrow(UnsupportedUpstreamError);
      expect(() => desiredGateway(onNode(node), hubSettings)).toThrow(UnsupportedUpstreamError);
    });
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
    expect(gatewayClientName(settings, 'salud')).toBe('den-gateway.salud');
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
    // The official only as their keyed hash, never X-DEN-End-User in clear.
    expect(Object.values(TRANSPARENCY_LOG_FORMAT)).not.toContain('$http_x_den_end_user');
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
    const desired = { a: 1, plugins: { opa: { policy: 'den/authz' } }, methods: ['GET'] };
    expect(
      matches(desired, {
        ...desired,
        create_time: 1,
        plugins: { opa: { policy: 'den/authz', timeout: 3000 } },
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

  it('serves the server certificate on the gateway names; the client CA rejects in the handshake only with mTLS', () => {
    const plain = desiredSsl(certificate, settings);
    expect(plain).toMatchObject({ type: 'server', snis: ['gw.example.org', 'localhost'] });
    // Without network-wide mTLS the certificate is optional, except on the node control channel.
    expect(plain.client).toEqual({
      ca: 'CA',
      depth: 2,
      skip_mtls_uri_regex: [NODE_ONLY_SKIP_MTLS_REGEX],
    });
    const mtls = desiredSsl(certificate, {
      ...settings,
      tls: { ...settings.tls, mtlsRequired: true },
    });
    expect(mtls.client).toEqual({ ca: 'CA', depth: 2 });
    expect(mtls).not.toHaveProperty('client.skip_mtls_uri_regex');
  });

  it('ignores the stored (encrypted) key but notices an exemption left behind', () => {
    const desired = desiredSsl(certificate, {
      ...settings,
      tls: { ...settings.tls, mtlsRequired: true },
    });
    const stored = { ...desired, key: 'encrypted-by-apisix', validity_end: 1 };
    expect(sslMatches(desired, stored)).toBe(true);
    expect(
      sslMatches(desired, {
        ...stored,
        client: { ca: 'CA', depth: 2, skip_mtls_uri_regex: ['.*'] },
      }),
    ).toBe(false);
    expect(sslMatches(desired, { ...stored, cert: 'OTHER' })).toBe(false);
  });

  it('requires the certificate on the node control paths only, enrollment excluded (M4-02)', () => {
    const skip = new RegExp(NODE_ONLY_SKIP_MTLS_REGEX);
    const id = '0190d0c4-0000-7000-8000-000000000001';
    for (const path of ['heartbeat', 'renew', 'config']) {
      expect(skip.test(`/api/v1/nodes/${id}/${path}`), path).toBe(false);
    }
    for (const path of [
      '/api/v1/nodes/enroll',
      '/salud/afiliacion/v1/x',
      '/oauth/token',
      `/api/v1/nodes/${id}/heartbeat/x`,
    ]) {
      expect(skip.test(path), path).toBe(true);
    }
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

describe('node control route (M4-02)', () => {
  it('is absent until the portal URL and the control token are configured', () => {
    expect(desiredNodeControlRoute(settings)).toBeNull();
  });

  it('forwards to the portal with the verified thumbprint and the control token', () => {
    const route = desiredNodeControlRoute({
      ...settings,
      nodeControl: { portalUrl: 'http://api:4000', token: 'control-token' },
    });
    expect(route).toMatchObject({
      uri: '/api/v1/nodes/*',
      methods: ['GET', 'POST'],
      upstream: { scheme: 'http', nodes: { 'api:4000': 1 }, pass_host: 'node' },
    });
    const plugins = route?.plugins as Record<string, unknown>;
    // The client's X-DEN-* (a forged control token included) go first; then the thumbprint.
    expect(plugins['den-header-guard']).toEqual({});
    expect(plugins['den-client-cert']).toEqual({});
    expect(plugins['proxy-rewrite']).toEqual({
      headers: { set: { 'X-DEN-Node-Control': 'control-token' } },
    });
    expect(plugins).not.toHaveProperty('openid-connect');
  });
});

describe('token route (S-4, M3-10)', () => {
  it('forwards to the den-gateway token endpoint with the verified certificate', () => {
    const route = desiredTokenRoute(settings);
    expect(route).toMatchObject({
      uri: '/oauth/token',
      methods: ['POST'],
      upstream: { scheme: 'http', nodes: { 'keycloak:8080': 1 }, pass_host: 'node' },
    });
    const plugins = route.plugins as Record<string, Record<string, unknown>>;
    expect(plugins['proxy-rewrite']).toEqual({
      uri: '/realms/den-gateway/protocol/openid-connect/token',
      headers: {
        // The other spellings of the two headers go; the exact names are always overwritten.
        remove: ['SSL-CLIENT-CERT', 'ssl_client_verify'],
        set: {
          SSL_CLIENT_CERT: '$ssl_client_escaped_cert',
          'ssl-client-verify': '$ssl_client_verify',
        },
      },
    });
    expect(plugins).toHaveProperty('den-header-guard');
  });

  it('keeps the base path of a Keycloak served under one (the pilot: /auth)', () => {
    const route = desiredTokenRoute({
      ...settings,
      keycloakDiscoveryUrl:
        'http://keycloak:8080/auth/realms/den-gateway/.well-known/openid-configuration',
    });
    expect((route.plugins as Record<string, { uri?: string }>)['proxy-rewrite']?.uri).toBe(
      '/auth/realms/den-gateway/protocol/openid-connect/token',
    );
  });
});

describe('development nodes (DEN_DEV_NODES)', () => {
  it('uses the entity slug first, then the longest prefix (M6-03)', () => {
    const nodes = parseDevNodes(
      'salud=mock-salud:8000,carga-*=mock-socioeconomico:8000,carga-0*=https://mock-salud:8443',
    );
    expect(devNodeOf(nodes, 'salud')?.hostPort).toBe('mock-salud:8000');
    expect(devNodeOf(nodes, 'carga-123')?.hostPort).toBe('mock-socioeconomico:8000');
    expect(devNodeOf(nodes, 'carga-012')).toMatchObject({ hostPort: 'mock-salud:8443', tls: true });
    expect(devNodeOf(nodes, 'otra')).toBeUndefined();
  });
});
