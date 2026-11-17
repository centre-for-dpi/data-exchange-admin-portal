import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import {
  isPublicHostname,
  nodeDnsName,
  type Upstream,
  xroadPartSchema,
  xroadServicePath,
  xroadServicePathSchema,
} from '@rid/contracts';
import type { ApisixObject } from './apisix-admin.js';

/** Deterministic ids (ARCHITECTURE.md §4): reconciling needs no extra state. */
export const ROUTE_PREFIX = 'rid-route-';
export const routeId = (apiVersionId: string): string => `${ROUTE_PREFIX}${apiVersionId}`;
export const upstreamId = (apiVersionId: string): string => `rid-upstream-${apiVersionId}`;
/** The gateway's TLS (server certificate and, with mTLS, the client CA) on its public names. */
export const GATEWAY_SSL_ID = 'rid-ssl-gateway';
/**
 * The gateway's client certificates towards upstreams with mTLS (M3-03): one per provider entity,
 * CN=<clientName>.<entity slug>. A provider accepts only its own name, so a route of another
 * entity pointed at its API cannot borrow the gateway's identity (confused deputy).
 */
export const GATEWAY_CLIENT_SSL_PREFIX = 'rid-ssl-gateway-client-';
export const gatewayClientSslId = (entityId: string): string =>
  `${GATEWAY_CLIENT_SSL_PREFIX}${entityId}`;
export const gatewayClientName = (settings: GatewaySettings, entitySlug: string): string =>
  `${settings.tls.clientName}.${entitySlug}`;
/** Only objects with this prefix belong to the portal; anything else in APISIX is left alone. */
export const MANAGED_PREFIX = 'rid-';

/** Where the gateway reaches the platform services (container network names in development). */
export interface GatewaySettings {
  /** OIDC discovery of the rid-gateway realm, as APISIX reaches Keycloak. */
  keycloakDiscoveryUrl: string;
  /** Audience every application token must carry (= client_id of the openid-connect plugin). */
  audience: string;
  /** Local OPA next to the gateway. */
  opaUrl: string;
  /** Fluent Bit HTTP input for access logs (ARCHITECTURE.md §8). */
  accessLogUrl: string;
  /** Fluent Bit TCP input of the transparency register (ADR-0015, ARCHITECTURE.md §13). */
  transparencyLog: { host: string; port: number };
  /**
   * Development stand-in for kit nodes until M4: entity slug -> host:port of its mock provider
   * (RID_DEV_NODES). Nodes enrolled through the portal replace it.
   */
  devNodes: ReadonlyMap<string, DevNode>;
  /** Every address a host name resolves to (A and AAAA); injectable for tests. */
  resolveHost: (host: string) => Promise<string[]>;
  /**
   * TLS of the gateway (M3-02): its public host names (RID_GATEWAY_TLS_HOSTS) and whether every
   * call must present a client certificate of the network CA (features.mtls.required).
   */
  tls: {
    hosts: string[];
    mtlsRequired: boolean;
    /**
     * Prefix of the CN the gateway presents to upstreams (RID_GATEWAY_CLIENT_NAME), followed by the
     * provider entity's slug.
     */
    clientName: string;
  };
  /**
   * Control channel of kit nodes (M4-02): the portal's API as APISIX reaches it
   * (RID_GATEWAY_PORTAL_API_URL) and the token that proves a request came through the gateway
   * (RID_NODE_CONTROL_TOKEN). Without both, the gateway has no control route.
   */
  nodeControl?: { portalUrl: string; token: string };
  /**
   * The hub's SNI router as APISIX reaches it (RID_GATEWAY_WG_HUB, `wg-hub:8443`): versions on
   * enrolled kit nodes go there (M4-04, ADR-0023).
   */
  wgHub?: string;
  /**
   * The operator's X-Road Security Server (M4-05, SPIKE S-5): its URL, the operator's client
   * subsystem (INSTANCE/CLASS/MEMBER/SUBSYSTEM) and, over HTTPS, the PEM that verifies its
   * internal TLS certificate. Without it, xroad versions stay in sync error.
   */
  xroad?: { securityServerUrl: string; client: string; caPem?: string };
  /**
   * The gateway's signed assertion to providers (features.gatewayAssertion, ADR-0024, M6-10):
   * its issuer (the gateway's public URL). Without it, routes carry no rid-assertion.
   */
  assertion?: { issuer: string };
  /**
   * Token of the check routes of versions in review (M4-06, RID_VALIDATION_TOKEN): only the
   * portal's validations reach them. Without it there are no check routes.
   */
  validationToken?: string;
}

/**
 * Sandbox of a published version (M4-08): its own route, outside rid-route-, under /sandbox, to
 * the version's sandbox upstream. Only sandbox applications reach it (OPA).
 */
export const SANDBOX_ROUTE_PREFIX = 'rid-sandbox-';
export const sandboxRouteId = (apiVersionId: string): string =>
  `${SANDBOX_ROUTE_PREFIX}${apiVersionId}`;
export const sandboxBasePath = (basePath: string): string => `/sandbox${basePath}`;

/** Check routes of a version in review (M4-06): ids outside rid-route-, paths under /__rid/. */
export const CHECK_ROUTE_PREFIX = 'rid-check-';
export const checkRouteId = (apiVersionId: string): string =>
  `${CHECK_ROUTE_PREFIX}${apiVersionId}`;
export const sandboxCheckRouteId = (apiVersionId: string): string =>
  `${CHECK_ROUTE_PREFIX}sandbox-${apiVersionId}`;
export const checkRoutePath = (apiVersionId: string): string => `/__rid/check/${apiVersionId}`;
export const sandboxCheckRoutePath = (apiVersionId: string): string =>
  `/__rid/check-sandbox/${apiVersionId}`;
/** Only a request with the validation token matches a check route (APISIX `vars`). */
export const VALIDATION_TOKEN_HEADER = 'X-RID-Validation';

/**
 * The token of one version's check routes: HMAC of RID_VALIDATION_TOKEN and the version id. A
 * token that leaks (a redirect, a log of the provider) opens only that version's routes.
 */
export const versionCheckToken = (secret: string, apiVersionId: string): string =>
  createHmac('sha256', secret).update(`rid-check:${apiVersionId}`).digest('base64url');

/** The gateway's client certificate towards the operator's Security Server (one for X-Road). */
export const GATEWAY_XROAD_SSL_ID = 'rid-ssl-gateway-xroad';
/** X-Road request headers a consumer could use to steer the Security Server (SPIKE S-5). */
export const XROAD_CONTROL_HEADERS = [
  'X-Road-Security-Server',
  'X-Road-Represented-Party',
  'X-Road-Id',
  'X-Road-Request-Hash',
];
/** Decided by OPA on xroad routes: removed when the policy does not return them. */
export const XROAD_OPA_HEADERS = ['X-Road-UserId', 'X-Road-Issue'];

/** Headers only the gateway may set: removed if a client sends them (ARCHITECTURE.md §4.1). */
export const GATEWAY_ONLY_HEADERS = [
  'X-RID-Consumer-Entity',
  'X-RID-Consumer-App',
  'X-RID-Subscription',
  'X-RID-Operation',
  'X-RID-End-User-Hash',
  'X-RID-Subject-Ref',
];

/**
 * Headers OPA decides on; any of them the policy does not return is removed (S-1). The policy
 * never returns X-RID-End-User nor X-RID-Body-Subject: the clear values OPA reads (the official,
 * the data subject the gateway took from the body) do not reach the provider (ADR-0015, ADR-0017).
 */
export const OPA_UPSTREAM_HEADERS = [
  'X-RID-Consumer-Entity',
  'X-RID-Consumer-App',
  'X-RID-Subscription',
  'X-RID-Purpose',
  'X-RID-Operation',
  // The subscription's limit for limit-count (S-2): the client never chooses it.
  'X-RID-Rate-Limit',
  'X-RID-End-User-Hash',
  'X-RID-Subject-Ref',
  'X-RID-End-User',
  'X-RID-Body-Subject',
  // Thumbprint of the verified client certificate, set by rid-client-cert (S-3): OPA reads it,
  // the provider never gets it.
  'X-RID-Client-Cert-S256',
  // Legacy consumer-declared header (before ADR-0017): never forwarded either.
  'X-RID-Data-Subject',
  'X-Request-Id',
];

/**
 * Access-log record (ARCHITECTURE.md §8): metadata only. Never $uri, $request_uri or
 * $upstream_uri (they carry identifiers), never bodies or the Authorization header.
 */
const ACCESS_LOG_FORMAT = {
  ts: '$time_iso8601',
  request_id: '$http_x_request_id',
  route_id: '$route_id',
  operation: '$http_x_rid_operation',
  method: '$request_method',
  status: '$status',
  latency_ms: '$request_time',
  upstream_latency_ms: '$upstream_response_time',
  consumer_entity: '$http_x_rid_consumer_entity',
  consumer_app: '$http_x_rid_consumer_app',
  subscription_id: '$http_x_rid_subscription',
  purpose: '$http_x_rid_purpose',
  end_user_hash: '$http_x_rid_end_user_hash',
  bytes_sent: '$bytes_sent',
  gateway_node: '$hostname',
  deny_reason: '$sent_http_x_rid_deny_reason',
  // On a denial OPA names a known client in its response (M5-03); Fluent Bit folds these into
  // consumer_app and consumer_entity and drops them (infra/fluent-bit/allowlist.lua).
  deny_consumer_app: '$sent_http_x_rid_consumer_app',
  deny_consumer_entity: '$sent_http_x_rid_consumer_entity',
};

/**
 * Transparency record (ADR-0015, MT-03): who consulted whose data, as the keyed pseudonym OPA
 * computed. Like the access log, never the path, the query or bodies, so the document number
 * cannot reach the pipeline. A record only counts when the call reached the provider
 * ($upstream_status, set by nginx, never by the client) and carries the reference OPA returned
 * (the gateway removes a client-sent one before OPA). $request_id is nginx's random id, which a
 * client cannot choose (unlike X-Request-Id): it is the record's idempotency key.
 */
export const TRANSPARENCY_LOG_FORMAT = {
  ts: '$msec',
  gateway_node: '$hostname',
  gateway_request_id: '$request_id',
  request_id: '$http_x_request_id',
  route_id: '$route_id',
  operation: '$http_x_rid_operation',
  subscription_id: '$http_x_rid_subscription',
  consumer_entity: '$http_x_rid_consumer_entity',
  consumer_app: '$http_x_rid_consumer_app',
  purpose: '$http_x_rid_purpose',
  end_user_hash: '$http_x_rid_end_user_hash',
  subject_ref: '$http_x_rid_subject_ref',
  status: '$status',
  upstream_status: '$upstream_status',
};

export interface VersionForGateway {
  id: string;
  basePath: string;
  upstream: Upstream;
  /** Provider entity: the gateway presents that entity's client certificate (M3-03). */
  entityId: string;
  /** Public addresses the reconciler resolved for a direct upstream's host name. */
  addresses?: readonly string[];
  /** HTTP methods declared in the OpenAPI document. */
  methods: readonly string[];
  /** Operations whose data subject is in the JSON body (x-rid-data-subject in: body). */
  bodySubjects: ReadonlyArray<{
    method: string;
    /** Anchored regex on the full public path (as in the OPA bundle). */
    pathRegex: string;
    pointer: string;
    typePointer?: string;
  }>;
  /** True when some operation declares its data subject (path or body): calls are registered. */
  hasDataSubjects: boolean;
  entitySlug: string;
  apiName: string;
  version: string;
  /** Set while the version is deprecated (ADR-0019): announced on every response. */
  deprecation?: { deprecatedAt: Date; sunsetAt: Date };
  /** The provider entity's X-Road member, as the operator set it (M4-05). */
  xroadMember?: { memberClass: string; memberCode: string } | null;
  /** The kit node a `node` upstream with a nodeId names, as stored (M4-04). */
  node?: { id: string; entityId: string; status: string } | null;
}

/** Node statuses the gateway calls: an offline node keeps its route and answers when it is back. */
const SERVED_NODE_STATUSES = ['enrolled', 'online', 'offline'];

/**
 * Deprecation (RFC 9745, `@` + Unix seconds) and Sunset (RFC 8594, HTTP-date) response headers.
 */
export function deprecationHeaders(d: {
  deprecatedAt: Date;
  sunsetAt: Date;
}): Record<string, string> {
  return {
    Deprecation: `@${Math.floor(d.deprecatedAt.getTime() / 1000)}`,
    Sunset: d.sunsetAt.toUTCString(),
  };
}

/** A version the gateway cannot serve yet; recorded as a sync error, never half-applied. */
export class UnsupportedUpstreamError extends Error {}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface ResolvedUpstream {
  upstream: ApisixObject;
  /** Path prefix of the service on the upstream. */
  pathPrefix: string;
}

/** The network CA as APISIX takes it for upstream verification: one PEM per certificate. */
const certificatesOf = (pem: string): string[] =>
  (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
    (c) => `${c}\n`,
  );

const nodeKey = (address: string, port: string): string =>
  `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;

/** What the gateway needs from its own PKI to build an upstream (M3-03). */
export interface UpstreamPki {
  /** The network CA (intermediates and root, PEM): verifies kit nodes. */
  networkCaPem: string;
}

function resolveUpstream(
  v: VersionForGateway,
  settings: GatewaySettings,
  pki?: UpstreamPki,
): ResolvedUpstream {
  const base = {
    type: 'roundrobin',
    timeout: { connect: 5, send: 30, read: 30 },
    labels: { 'rid-managed': 'true', 'rid-api-version': v.id },
  };
  if (v.upstream.type === 'direct') {
    const url = new URL(v.upstream.url);
    // Also checked when the version is registered; repeated here for rows written before.
    if (!isPublicHostname(url.hostname)) {
      throw new UnsupportedUpstreamError(`Upstream host ${url.hostname} is not a public address`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port || '443';
    // The addresses the reconciler resolved and found public: APISIX connects to those and not
    // to whatever the name resolves to later (no DNS rebinding between passes). The name stays
    // as Host and as SNI, and the provider's certificate must be valid for it.
    const addresses = [...new Set(v.addresses?.length ? v.addresses : [host])].sort();
    return {
      upstream: {
        ...base,
        scheme: 'https',
        pass_host: 'rewrite',
        upstream_host: url.hostname,
        nodes: Object.fromEntries(addresses.map((a) => [nodeKey(a, port), 1])),
        tls: {
          verify: true,
          // mTLS towards the provider's existing API (M3-03): the gateway's client certificate.
          ...(v.upstream.mtls ? { client_cert_id: gatewayClientSslId(v.entityId) } : {}),
        },
      },
      pathPrefix: url.pathname.replace(/\/$/, ''),
    };
  }
  if (v.upstream.type === 'xroad') return xroadUpstream(v, base, settings);
  if (v.upstream.nodeId) {
    return {
      upstream: nodeUpstream(v, v.upstream.nodeId, base, settings, pki),
      pathPrefix: v.upstream.servicePath.replace(/\/$/, ''),
    };
  }
  const node = devNodeOf(settings.devNodes, v.entitySlug);
  if (!node) {
    throw new UnsupportedUpstreamError(
      `No development node for entity "${v.entitySlug}" (set RID_DEV_NODES)`,
    );
  }
  const pathPrefix = v.upstream.servicePath.replace(/\/$/, '');
  if (!node.tls) {
    return {
      upstream: { ...base, scheme: 'http', pass_host: 'pass', nodes: { [node.hostPort]: 1 } },
      pathPrefix,
    };
  }
  // A node served over TLS (kit nodes from M4; development nodes declared https://): mTLS with
  // the gateway's client certificate, and the node's certificate verified against the network CA
  // for the node's name.
  const ca = pki ? certificatesOf(pki.networkCaPem) : [];
  if (ca.length === 0) {
    throw new UnsupportedUpstreamError('The network CA is not available to verify the node');
  }
  return {
    upstream: {
      ...base,
      scheme: 'https',
      pass_host: 'rewrite',
      upstream_host: node.host,
      nodes: { [node.hostPort]: 1 },
      tls: { client_cert_id: gatewayClientSslId(v.entityId), verify: true, ca_certs: ca },
    },
    pathPrefix,
  };
}

/**
 * Upstream of a version consumed through X-Road (M4-05, SPIKE S-5): the operator's Security
 * Server, never a URL of the version (SSRF), with the serviceId in the path. The serviceId's
 * member must be the entity's X-Road member, checked again here (fail closed): every xroad route
 * leaves with the operator's identity, so no entity may serve another member's service.
 */
function xroadUpstream(
  v: VersionForGateway,
  base: ApisixObject,
  settings: GatewaySettings,
): ResolvedUpstream {
  if (v.upstream.type !== 'xroad') throw new UnsupportedUpstreamError('Not an xroad upstream');
  const { serviceId, servicePath } = v.upstream;
  if (!settings.xroad) {
    throw new UnsupportedUpstreamError('X-Road is not configured (RID_XROAD_SECURITY_SERVER_URL)');
  }
  const parts = [
    serviceId.instance,
    serviceId.memberClass,
    serviceId.memberCode,
    serviceId.subsystemCode,
    serviceId.serviceCode,
  ].filter((p): p is string => p !== undefined);
  if (
    parts.some((part) => !xroadPartSchema.safeParse(part).success) ||
    !xroadServicePathSchema.safeParse(servicePath).success
  ) {
    throw new UnsupportedUpstreamError('The X-Road service identifier or path is not valid');
  }
  // The operator's instance only: its Security Server serves no other (no federation here).
  if (serviceId.instance !== settings.xroad.client.split('/')[0]) {
    throw new UnsupportedUpstreamError('The service is not in the operator’s X-Road instance');
  }
  const member = v.xroadMember;
  if (
    !member ||
    member.memberClass !== serviceId.memberClass ||
    member.memberCode !== serviceId.memberCode
  ) {
    throw new UnsupportedUpstreamError('The service is not of the entity’s X-Road member');
  }
  const url = new URL(settings.xroad.securityServerUrl);
  const tls = url.protocol === 'https:';
  const ca = settings.xroad.caPem ? certificatesOf(settings.xroad.caPem) : [];
  return {
    upstream: {
      ...base,
      scheme: tls ? 'https' : 'http',
      pass_host: 'rewrite',
      upstream_host: url.hostname,
      nodes: { [nodeKey(url.hostname, url.port || (tls ? '443' : '80'))]: 1 },
      ...(tls
        ? {
            tls: {
              verify: true,
              client_cert_id: GATEWAY_XROAD_SSL_ID,
              ...(ca.length ? { ca_certs: ca } : {}),
            },
          }
        : {}),
    },
    // Literal parts: APISIX encodes upstream_uri itself (S-5).
    pathPrefix: `${url.pathname.replace(/\/$/, '')}${xroadServicePath(serviceId)}${servicePath.replace(/\/$/, '')}`,
  };
}

/**
 * Upstream of a version served by an enrolled kit node (M4-04, ADR-0023): APISIX opens TLS to
 * the hub's SNI router with the node's name as SNI, Host and verified name, presents the provider
 * entity's client certificate (M3-03) and verifies the node's certificate against the network CA.
 * The hub passes the connection to the node's tunnel address. A node of another entity, not
 * enrolled or decommissioned, is never called: fail closed.
 */
function nodeUpstream(
  v: VersionForGateway,
  nodeId: string,
  base: ApisixObject,
  settings: GatewaySettings,
  pki?: UpstreamPki,
): ApisixObject {
  const node = v.node;
  if (!node || node.id !== nodeId || node.entityId !== v.entityId) {
    throw new UnsupportedUpstreamError(`Node ${nodeId} is not a node of the provider entity`);
  }
  if (!SERVED_NODE_STATUSES.includes(node.status)) {
    throw new UnsupportedUpstreamError(`Node ${nodeId} is ${node.status}`);
  }
  if (!settings.wgHub) {
    throw new UnsupportedUpstreamError('The WireGuard hub is not configured (RID_GATEWAY_WG_HUB)');
  }
  const ca = pki ? certificatesOf(pki.networkCaPem) : [];
  if (ca.length === 0) {
    throw new UnsupportedUpstreamError('The network CA is not available to verify the node');
  }
  return {
    ...base,
    scheme: 'https',
    pass_host: 'rewrite',
    upstream_host: nodeDnsName(nodeId),
    nodes: { [settings.wgHub]: 1 },
    tls: { client_cert_id: gatewayClientSslId(v.entityId), verify: true, ca_certs: ca },
  };
}

/**
 * Whether building this upstream needs the gateway's PKI (its client certificate and the network
 * CA): direct upstreams with mTLS and nodes served over TLS.
 */
export function needsGatewayPki(
  upstream: Upstream,
  entitySlug: string,
  settings: GatewaySettings,
): boolean {
  if (upstream.type === 'direct') return upstream.mtls;
  if (upstream.type === 'node' && !upstream.nodeId) {
    return devNodeOf(settings.devNodes, entitySlug)?.tls ?? false;
  }
  // Enrolled kit nodes are always called over mTLS (M4-04).
  return upstream.type === 'node';
}

/** True when the upstream presents the gateway's client certificate (it needs that SSL object). */
export const usesGatewayClientCertificate = (upstream: ApisixObject): boolean =>
  (upstream.tls as { client_cert_id?: string } | undefined)?.client_cert_id?.startsWith(
    GATEWAY_CLIENT_SSL_PREFIX,
  ) ?? false;

export interface DesiredGateway {
  upstream: ApisixObject;
  route: ApisixObject;
}

/**
 * Upstream and route of a published API version (ARCHITECTURE.md §4.1). `limit-count` arrives with
 * SPIKE S-2 (M3) and mTLS with M3; until OPA's policy exists (M1-09) the route denies every call.
 */
export function desiredGateway(
  v: VersionForGateway,
  settings: GatewaySettings,
  pki?: UpstreamPki,
): DesiredGateway {
  const { upstream, pathPrefix } = resolveUpstream(v, settings, pki);
  const route: ApisixObject = {
    name: `${v.entitySlug} ${v.apiName} ${v.version}`.slice(0, 100),
    uri: `${v.basePath}/*`,
    methods: [...new Set(v.methods.map((m) => m.toUpperCase()))].sort(),
    upstream_id: upstreamId(v.id),
    status: 1,
    labels: { 'rid-managed': 'true', 'rid-entity': v.entitySlug, 'rid-api-version': v.id },
    plugins: {
      'request-id': { header_name: 'X-Request-Id', include_in_response: true },
      // Anti-spoofing (M3-07): every client-sent X-RID-* header except X-RID-Purpose and
      // X-RID-End-User is removed before anything reads it.
      'rid-header-guard': {},
      'openid-connect': {
        client_id: settings.audience,
        discovery: settings.keycloakDiscoveryUrl,
        bearer_only: true,
        use_jwks: true,
        set_userinfo_header: false,
        set_access_token_header: false,
        set_id_token_header: false,
        // Tokens must be issued for the gateway (aud = rid-gateway), not for another client.
        claim_validator: { audience: { required: true, match_with_client_id: true } },
      },
      // Thumbprint of the client certificate verified in the handshake, for OPA (S-3). A value the
      // client sends in that header is always removed, with or without mTLS.
      'rid-client-cert': {},
      'proxy-rewrite': {
        // Only upstream_uri changes; OPA still sees the full public path.
        regex_uri: [`^${escapeRegex(v.basePath)}/(.*)$`, `${pathPrefix}/$1`],
        headers:
          v.upstream.type === 'xroad' && settings.xroad
            ? {
                // The operator's subsystem always; the consumer cannot steer the Security Server.
                set: { 'X-Road-Client': settings.xroad.client },
                remove: [...GATEWAY_ONLY_HEADERS, ...XROAD_CONTROL_HEADERS],
              }
            : { remove: GATEWAY_ONLY_HEADERS },
      },
      opa: {
        host: settings.opaUrl,
        // Only what the plugin reads (M6-03): see decision in packages/policy/rid/authz.rego.
        policy: 'rid/authz/decision',
        with_route: true,
        // Kept connections to the local OPA per worker (M6-03). With the default of 5, every call
        // beyond them opened and closed its own: at 500 req/s, thousands in TIME_WAIT and connects
        // that stalled until the decision timed out.
        keepalive: true,
        keepalive_pool: OPA_KEEPALIVE_POOL,
        keepalive_timeout: 60_000,
        send_headers_upstream:
          v.upstream.type === 'xroad'
            ? [...OPA_UPSTREAM_HEADERS, ...XROAD_OPA_HEADERS]
            : OPA_UPSTREAM_HEADERS,
      },
      // Per-subscription limit (S-2, ADR-0020): OPA puts the subscription and its share of the
      // limit for this node in headers; counters live in each node. A denied call never gets here.
      'limit-count': {
        count: '$http_x_rid_rate_limit',
        time_window: 60,
        key_type: 'var',
        key: 'http_x_rid_subscription',
        policy: 'local',
        rejected_code: 429,
        show_limit_quota_header: true,
      },
      // That 429 in problem+json; a provider's own 429 passes untouched.
      'rid-rate-limited': {},
      // The signed assertion of what OPA authorized, for the provider entity (ADR-0024, M6-10);
      // its key is in the plugin's metadata (ApisixReconciler.reconcileAssertionKey).
      ...(settings.assertion ? { 'rid-assertion': { audience: v.entitySlug } } : {}),
      prometheus: { prefer_name: false },
      ...(v.deprecation
        ? { 'response-rewrite': { headers: { set: deprecationHeaders(v.deprecation) } } }
        : {}),
      'http-logger': {
        uri: settings.accessLogUrl,
        include_req_body: false,
        include_resp_body: false,
        batch_max_size: 100,
        inactive_timeout: 2,
        log_format: ACCESS_LOG_FORMAT,
      },
      // Calls on operations with a data subject go to the transparency register (ADR-0015), on
      // a pipeline of their own, separate from the analytics log above.
      ...(v.hasDataSubjects
        ? {
            'tcp-logger': {
              host: settings.transparencyLog.host,
              port: settings.transparencyLog.port,
              include_req_body: false,
              include_resp_body: false,
              batch_max_size: 100,
              inactive_timeout: 1,
              // Fluent Bit keeps its own disk buffer; these retries cover it restarting.
              max_retry_count: 10,
              retry_delay: 2,
              log_format: TRANSPARENCY_LOG_FORMAT,
            },
          }
        : {}),
      // Data subjects declared in the body are read by the gateway, never asserted by the
      // consumer (ADR-0017). Only routes that have such operations carry the plugin.
      ...(v.bodySubjects.length > 0
        ? {
            'rid-data-subject': {
              operations: v.bodySubjects.map((s) => ({
                method: s.method.toUpperCase(),
                uri: s.pathRegex,
                pointer: s.pointer,
                ...(s.typePointer ? { type_pointer: s.typePointer } : {}),
              })),
            },
          }
        : {}),
    },
  };
  return { upstream, route };
}

/** Paths of the node control channel that need the node's certificate (M4-02). */
export const NODE_CONTROL_PATH_PREFIX = '/api/v1/nodes/';
/**
 * Without network-wide mTLS the certificate is optional everywhere except on the control channel
 * of kit nodes, whose calls APISIX refuses without a verified certificate (M4-02). Enrollment
 * stays open: the kit has no certificate yet.
 */
export const NODE_ONLY_SKIP_MTLS_REGEX = '^(?!/api/v1/nodes/[^/]+/(heartbeat|renew|config)$)';

/**
 * SSL object of the gateway (S-3): its server certificate on the public names and `client.ca`
 * with the network CA. When the network requires mTLS, APISIX refuses in the handshake any call
 * without a valid client certificate (no skip_mtls_uri_regex: no route is exempt). Otherwise the
 * certificate is optional but still verified when presented, and required on the node control
 * channel (M4-02).
 */
export function desiredSsl(
  certificate: { hosts: string[]; certificatePem: string; keyPem: string; networkCaPem: string },
  settings: GatewaySettings,
): ApisixObject {
  return {
    type: 'server',
    snis: certificate.hosts,
    cert: certificate.certificatePem,
    key: certificate.keyPem,
    ssl_protocols: ['TLSv1.2', 'TLSv1.3'],
    labels: { 'rid-managed': 'true' },
    status: 1,
    // Leaf, intermediate and root: depth 2.
    client: settings.tls.mtlsRequired
      ? { ca: certificate.networkCaPem, depth: 2 }
      : {
          ca: certificate.networkCaPem,
          depth: 2,
          skip_mtls_uri_regex: [NODE_ONLY_SKIP_MTLS_REGEX],
        },
  };
}

/** The gateway's own route to the token endpoint of rid-gateway (S-4, M3-10). */
export const TOKEN_ROUTE_ID = 'rid-oauth-token';
/** Where applications ask for their token: the same name and TLS as their calls. */
export const GATEWAY_TOKEN_PATH = '/oauth/token';

/**
 * Headers Keycloak's x509 lookup (provider nginx, trust-proxy-verification) reads: the client
 * certificate APISIX verified in the handshake and the outcome of that verification (S-4).
 */
export const CLIENT_CERT_HEADERS = { cert: 'SSL_CLIENT_CERT', verify: 'ssl-client-verify' };

/**
 * The token route (S-4 mount B, M3-10). Applications ask the gateway for their token, over the
 * TLS where APISIX verified their certificate; APISIX forwards to Keycloak's token endpoint with
 * the verified certificate in SSL_CLIENT_CERT and ssl-client-verify, always replacing whatever
 * the client sent under those names (spelled with hyphens or underscores, in any case). Keycloak
 * then binds the token to that certificate (cnf.x5t#S256). Without a verified certificate (plain
 * HTTP, or a network without mTLS) the headers carry nothing.
 */
export function desiredTokenRoute(settings: GatewaySettings): ApisixObject {
  // The discovery URL is <keycloak>/realms/rid-gateway/.well-known/openid-configuration.
  const discovery = new URL(settings.keycloakDiscoveryUrl);
  const realmPath = discovery.pathname.replace(/\/\.well-known\/openid-configuration$/, '');
  const port = discovery.port || (discovery.protocol === 'https:' ? '443' : '80');
  // The other spelling of each header (hyphens for underscores and back) is removed; the exact
  // names are set, which replaces a client's value in any letter case.
  const names = Object.values(CLIENT_CERT_HEADERS);
  const spellings = names
    .flatMap((name) => [name.replaceAll('_', '-'), name.replaceAll('-', '_')])
    .filter((spelling) => !names.includes(spelling));
  return {
    name: 'rid-gateway token endpoint',
    uri: GATEWAY_TOKEN_PATH,
    methods: ['POST'],
    status: 1,
    labels: { 'rid-managed': 'true' },
    upstream: {
      type: 'roundrobin',
      scheme: discovery.protocol.replace(':', ''),
      nodes: { [`${discovery.hostname}:${port}`]: 1 },
      // Keycloak sees its own internal name, as for every backchannel call.
      pass_host: 'node',
    },
    plugins: {
      'request-id': { header_name: 'X-Request-Id', include_in_response: true },
      'rid-header-guard': {},
      'proxy-rewrite': {
        uri: `${realmPath}/protocol/openid-connect/token`,
        headers: {
          remove: [...new Set(spellings)],
          set: {
            [CLIENT_CERT_HEADERS.cert]: '$ssl_client_escaped_cert',
            [CLIENT_CERT_HEADERS.verify]: '$ssl_client_verify',
          },
        },
      },
      prometheus: { prefer_name: false },
    },
  };
}

/**
 * APISIX stores the private key encrypted, so the key is not compared: a new key always comes
 * with a new certificate. A skip_mtls_uri_regex left behind (mTLS turned on) is a difference.
 */
export function sslMatches(desired: ApisixObject, actual: ApisixObject): boolean {
  const { key: _key, ...compared } = desired;
  const wantSkip = (desired.client as { skip_mtls_uri_regex?: unknown } | undefined)
    ?.skip_mtls_uri_regex;
  const hasSkip = (actual.client as { skip_mtls_uri_regex?: unknown } | undefined)
    ?.skip_mtls_uri_regex;
  if (wantSkip === undefined && hasSkip !== undefined && hasSkip !== null) return false;
  return matches(compared, actual);
}

/** The gateway's route for the control channel of kit nodes (M4-02). */
export const NODE_CONTROL_ROUTE_ID = 'rid-node-control';
/** Set by the control route: proves to the portal that the request came through the gateway. */
export const NODE_CONTROL_TOKEN_HEADER = 'X-RID-Node-Control';

/**
 * The node control route (ARCHITECTURE.md §10, M4-02). Nodes call the portal's control channel
 * on the gateway's TLS with their certificate; APISIX verifies it in the handshake, rid-client-cert
 * puts its thumbprint in X-RID-Client-Cert-S256 (always replacing the client's), and proxy-rewrite
 * adds the control token. rid-header-guard first removes every other X-RID-* the client sent,
 * the control token included. The portal believes the thumbprint only with the token.
 */
export function desiredNodeControlRoute(settings: GatewaySettings): ApisixObject | null {
  if (!settings.nodeControl) return null;
  const portal = new URL(settings.nodeControl.portalUrl);
  const port = portal.port || (portal.protocol === 'https:' ? '443' : '80');
  return {
    name: 'kit node control channel',
    uri: `${NODE_CONTROL_PATH_PREFIX}*`,
    methods: ['GET', 'POST'],
    status: 1,
    labels: { 'rid-managed': 'true' },
    upstream: {
      type: 'roundrobin',
      scheme: portal.protocol.replace(':', ''),
      nodes: { [`${portal.hostname}:${port}`]: 1 },
      pass_host: 'node',
    },
    plugins: {
      'request-id': { header_name: 'X-Request-Id', include_in_response: true },
      'rid-header-guard': {},
      'rid-client-cert': {},
      'proxy-rewrite': {
        headers: { set: { [NODE_CONTROL_TOKEN_HEADER]: settings.nodeControl.token } },
      },
      prometheus: { prefer_name: false },
    },
  };
}

/**
 * True when every field of `desired` has the same value in `actual`. APISIX stores defaults for
 * fields we do not set, so `actual` may hold more; arrays must match exactly.
 */
export function matches(desired: unknown, actual: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      desired.length === actual.length &&
      desired.every((item, i) => matches(item, actual[i]))
    );
  }
  if (desired !== null && typeof desired === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const a = actual as Record<string, unknown>;
    return Object.entries(desired).every(([key, value]) => matches(value, a[key]));
  }
  return desired === actual;
}

/** A development stand-in for a kit node: host:port, over TLS when declared https://. */
export interface DevNode {
  host: string;
  hostPort: string;
  tls: boolean;
}

/** Connections each APISIX worker keeps open to the local OPA (opa plugin, M6-03). */
export const OPA_KEEPALIVE_POOL = 64;

/**
 * RID_DEV_NODES="salud=mock-salud:8000,socioeconomico=https://mock-socioeconomico:8443": an
 * https:// node gets mTLS like an enrolled kit node (M3-03). A slug ending in `*` is a prefix
 * (`carga-*=mock-salud:8000`: the synthetic entities of the load test, M6-03).
 */
export function parseDevNodes(value: string | undefined): Map<string, DevNode> {
  const nodes = new Map<string, DevNode>();
  for (const pair of (value ?? '').split(',')) {
    const [slug, raw] = pair.split('=').map((s) => s.trim());
    const match = /^(https:\/\/)?([a-z0-9.-]+):(\d{1,5})$/i.exec(raw ?? '');
    if (slug && match?.[2] && match[3]) {
      nodes.set(slug, {
        host: match[2].toLowerCase(),
        hostPort: `${match[2].toLowerCase()}:${match[3]}`,
        tls: Boolean(match[1]),
      });
    }
  }
  return nodes;
}

/** The development node of an entity: its own slug first, then the longest matching prefix. */
export function devNodeOf(nodes: ReadonlyMap<string, DevNode>, slug: string): DevNode | undefined {
  const exact = nodes.get(slug);
  if (exact) return exact;
  let best: { length: number; node: DevNode } | undefined;
  for (const [key, node] of nodes) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (slug.startsWith(prefix) && prefix.length > (best?.length ?? -1)) {
      best = { length: prefix.length, node };
    }
  }
  return best?.node;
}

/** `host:port` (e.g. RID_GATEWAY_TRANSPARENCY_LOG); a malformed value is a startup error. */
export function parseHostPort(value: string): { host: string; port: number } {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(value.trim());
  const port = Number(match?.[2]);
  if (!match?.[1] || port < 1 || port > 65535) {
    throw new Error(`Expected host:port, got "${value}"`);
  }
  return { host: match[1], port };
}

/**
 * RID_GATEWAY_TLS_HOSTS="gw.example.org,gateway" -> DNS names of the gateway's certificate, in
 * order (the first is its common name). A malformed name is a startup error.
 */
export function parseHostNames(value: string): string[] {
  const hosts = [...new Set(value.split(',').map((h) => h.trim().toLowerCase()))].filter(Boolean);
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  for (const host of hosts) {
    if (host.length > 253 || !host.split('.').every((part) => label.test(part))) {
      throw new Error(`Invalid gateway host name "${host}"`);
    }
  }
  if (hosts.length === 0) throw new Error('RID_GATEWAY_TLS_HOSTS has no host name');
  return hosts;
}

/**
 * Check routes of a version in review (M4-06, SPEC.md §4.2 step 2). They skip the token and the
 * policy, so they are narrow: a route only matches with the validation token (APISIX `vars`), the
 * production one only answers GET on the service root (connectivity, never data), and only the
 * sandbox one, with synthetic data, takes any path for the contract test. The upstream goes inline
 * in the route, built like the published one (mTLS, hub, Security Server and their checks).
 */
export function desiredCheckRoutes(
  v: VersionForGateway & { sandboxUpstream?: Upstream | null },
  settings: GatewaySettings,
  pki?: UpstreamPki,
): { health: ApisixObject; sandbox: ApisixObject | null } | null {
  if (!settings.validationToken) return null;
  const token = versionCheckToken(settings.validationToken, v.id);
  const vars = [
    [`http_${VALIDATION_TOKEN_HEADER.toLowerCase().replaceAll('-', '_')}`, '==', token],
  ];
  const plugins = (extra: Record<string, unknown>) => ({
    'request-id': { header_name: 'X-Request-Id', include_in_response: true },
    'rid-header-guard': {},
    'proxy-rewrite': { ...extra, headers: { remove: [VALIDATION_TOKEN_HEADER] } },
  });
  const label = { 'rid-managed': 'true', 'rid-api-version': v.id, 'rid-check': 'true' };
  const production = resolveUpstream(v, settings, pki);
  const health: ApisixObject = {
    name: `check ${v.entitySlug} ${v.apiName} ${v.version}`.slice(0, 100),
    uri: checkRoutePath(v.id),
    methods: ['GET'],
    vars,
    status: 1,
    labels: label,
    upstream: production.upstream,
    plugins: plugins({ uri: `${production.pathPrefix}/` }),
  };
  if (!v.sandboxUpstream) return { health, sandbox: null };
  const sandbox = resolveUpstream({ ...v, upstream: v.sandboxUpstream }, settings, pki);
  return {
    health,
    sandbox: {
      name: `check sandbox ${v.entitySlug} ${v.apiName} ${v.version}`.slice(0, 100),
      uri: `${sandboxCheckRoutePath(v.id)}/*`,
      vars,
      status: 1,
      labels: label,
      upstream: sandbox.upstream,
      plugins: plugins({
        regex_uri: [
          `^${escapeRegex(sandboxCheckRoutePath(v.id))}/(.*)$`,
          `${sandbox.pathPrefix}/$1`,
        ],
      }),
    },
  };
}
