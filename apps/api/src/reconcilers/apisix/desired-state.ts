import { isPublicHostname, type Upstream } from '@rid/contracts';
import type { ApisixObject } from './apisix-admin.js';

/** Deterministic ids (ARCHITECTURE.md §4): reconciling needs no extra state. */
export const routeId = (apiVersionId: string): string => `rid-route-${apiVersionId}`;
export const upstreamId = (apiVersionId: string): string => `rid-upstream-${apiVersionId}`;
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
  /**
   * Development stand-in for kit nodes until M4: entity slug -> host:port of its mock provider
   * (RID_DEV_NODES). Nodes enrolled through the portal replace it.
   */
  devNodes: ReadonlyMap<string, string>;
  /** Every address a host name resolves to (A and AAAA); injectable for tests. */
  resolveHost: (host: string) => Promise<string[]>;
}

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
  'X-RID-End-User-Hash',
  'X-RID-Subject-Ref',
  'X-RID-End-User',
  'X-RID-Body-Subject',
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
};

export interface VersionForGateway {
  id: string;
  basePath: string;
  upstream: Upstream;
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
  entitySlug: string;
  apiName: string;
  version: string;
}

/** A version the gateway cannot serve yet; recorded as a sync error, never half-applied. */
export class UnsupportedUpstreamError extends Error {}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface ResolvedUpstream {
  upstream: ApisixObject;
  /** Path prefix of the service on the upstream. */
  pathPrefix: string;
}

function resolveUpstream(v: VersionForGateway, settings: GatewaySettings): ResolvedUpstream {
  const base = {
    type: 'roundrobin',
    timeout: { connect: 5, send: 30, read: 30 },
    labels: { 'rid-managed': 'true', 'rid-api-version': v.id },
  };
  if (v.upstream.type === 'direct') {
    if (v.upstream.mtls) {
      // Fail closed rather than reach the provider without the mTLS it asked for (ADR-0010).
      throw new UnsupportedUpstreamError('mTLS towards upstreams arrives with M3 (ADR-0010)');
    }
    const url = new URL(v.upstream.url);
    // Also checked when the version is registered; repeated here for rows written before.
    if (!isPublicHostname(url.hostname)) {
      throw new UnsupportedUpstreamError(`Upstream host ${url.hostname} is not a public address`);
    }
    return {
      upstream: {
        ...base,
        scheme: 'https',
        pass_host: 'node',
        nodes: { [`${url.hostname}:${url.port || '443'}`]: 1 },
      },
      pathPrefix: url.pathname.replace(/\/$/, ''),
    };
  }
  if (v.upstream.nodeId) {
    throw new UnsupportedUpstreamError('Upstreams on enrolled kit nodes arrive with M4');
  }
  const node = settings.devNodes.get(v.entitySlug);
  if (!node) {
    throw new UnsupportedUpstreamError(
      `No development node for entity "${v.entitySlug}" (set RID_DEV_NODES)`,
    );
  }
  return {
    upstream: { ...base, scheme: 'http', pass_host: 'pass', nodes: { [node]: 1 } },
    pathPrefix: v.upstream.servicePath.replace(/\/$/, ''),
  };
}

export interface DesiredGateway {
  upstream: ApisixObject;
  route: ApisixObject;
}

/**
 * Upstream and route of a published API version (ARCHITECTURE.md §4.1). `limit-count` arrives with
 * SPIKE S-2 (M3) and mTLS with M3; until OPA's policy exists (M1-09) the route denies every call.
 */
export function desiredGateway(v: VersionForGateway, settings: GatewaySettings): DesiredGateway {
  const { upstream, pathPrefix } = resolveUpstream(v, settings);
  const route: ApisixObject = {
    name: `${v.entitySlug} ${v.apiName} ${v.version}`.slice(0, 100),
    uri: `${v.basePath}/*`,
    methods: [...new Set(v.methods.map((m) => m.toUpperCase()))].sort(),
    upstream_id: upstreamId(v.id),
    status: 1,
    labels: { 'rid-managed': 'true', 'rid-entity': v.entitySlug, 'rid-api-version': v.id },
    plugins: {
      'request-id': { header_name: 'X-Request-Id', include_in_response: true },
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
      'proxy-rewrite': {
        // Only upstream_uri changes; OPA still sees the full public path.
        regex_uri: [`^${escapeRegex(v.basePath)}/(.*)$`, `${pathPrefix}/$1`],
        headers: { remove: GATEWAY_ONLY_HEADERS },
      },
      opa: {
        host: settings.opaUrl,
        policy: 'rid/authz',
        with_route: true,
        send_headers_upstream: OPA_UPSTREAM_HEADERS,
      },
      prometheus: { prefer_name: false },
      'http-logger': {
        uri: settings.accessLogUrl,
        include_req_body: false,
        include_resp_body: false,
        batch_max_size: 100,
        inactive_timeout: 2,
        log_format: ACCESS_LOG_FORMAT,
      },
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

/** RID_DEV_NODES="salud=mock-salud:8000,socioeconomico=mock-socioeconomico:8000" */
export function parseDevNodes(value: string | undefined): Map<string, string> {
  const nodes = new Map<string, string>();
  for (const pair of (value ?? '').split(',')) {
    const [slug, hostPort] = pair.split('=').map((s) => s.trim());
    if (slug && hostPort && /^[a-z0-9.-]+:\d{1,5}$/i.test(hostPort)) nodes.set(slug, hostPort);
  }
  return nodes;
}
