import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { isIP } from 'node:net';
import { isPublicAddress, type Upstream, upstreamSchema } from '@rid/contracts';
import { ZodError } from 'zod';
import { listOperations } from '../../apis/lint/openapi-lint.js';
import { pathRegex } from '../../opa/bundle.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import {
  APISIX_ADMIN,
  type ApisixAdmin,
  type ApisixObject,
  deleteUpstreamWhenUnused,
} from './apisix-admin.js';
import {
  CHECK_ROUTE_PREFIX,
  checkRouteId,
  desiredCheckRoutes,
  desiredGateway,
  desiredNodeControlRoute,
  desiredSsl,
  desiredTokenRoute,
  GATEWAY_CLIENT_SSL_PREFIX,
  GATEWAY_SSL_ID,
  GATEWAY_XROAD_SSL_ID,
  gatewayClientName,
  gatewayClientSslId,
  type GatewaySettings,
  MANAGED_PREFIX,
  matches,
  NODE_CONTROL_ROUTE_ID,
  needsGatewayPki,
  type UpstreamPki,
  routeId,
  SANDBOX_ROUTE_PREFIX,
  sandboxBasePath,
  sandboxCheckRouteId,
  sandboxRouteId,
  sslMatches,
  TOKEN_ROUTE_ID,
  UnsupportedUpstreamError,
  upstreamId,
} from './desired-state.js';
import { GatewayCertificates } from './gateway-certificates.js';

/** Outbox topic for changes that affect an API version's route (aggregate apiVersion:<id>). */
export const GATEWAY_SYNC_TOPIC = 'gateway.sync';
export const APISIX_SETTINGS = Symbol('APISIX_SETTINGS');
const FULL_RECONCILE_MS = 5 * 60 * 1000;

/** Versions the gateway serves: deprecated ones keep working until they are retired. */
const SERVED = ['published', 'deprecated'] as const;

export type GatewayResult = 'created' | 'updated' | 'unchanged' | 'deleted' | 'absent';

export const gatewaySyncTarget = (apiVersionId: string): string =>
  `apisix:route:${routeId(apiVersionId)}`;
export const GATEWAY_TLS_SYNC_TARGET = `apisix:ssl:${GATEWAY_SSL_ID}`;
export const GATEWAY_TOKEN_SYNC_TARGET = `apisix:route:${TOKEN_ROUTE_ID}`;
export const NODE_CONTROL_SYNC_TARGET = `apisix:route:${NODE_CONTROL_ROUTE_ID}`;
export const gatewayClientTlsSyncTarget = (entityId: string): string =>
  `apisix:ssl:${gatewayClientSslId(entityId)}`;

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Makes APISIX hold exactly one upstream and one route per served API version
 * (ARCHITECTURE.md §4, §4.1). Desired state comes from PostgreSQL only; the reconciler reads
 * APISIX, writes the difference with idempotent PUTs on deterministic ids and records the outcome
 * in sync_state. Runs from the outbox (gateway.sync) and as a full pass every 5 minutes, which
 * also removes `rid-` objects nothing in the database asks for. Objects without the prefix are
 * never touched.
 */
@Injectable()
export class ApisixReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ApisixReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(APISIX_ADMIN) private readonly admin: ApisixAdmin,
    @Inject(APISIX_SETTINGS) private readonly settings: GatewaySettings,
    private readonly certificates: GatewayCertificates,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(GATEWAY_SYNC_TOPIC, (data) => this.handle(data));
    // Converge right after a restart instead of waiting for the first periodic pass.
    void this.reconcileAll();
    this.timer = setInterval(() => void this.reconcileAll(), FULL_RECONCILE_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async handle(data: Record<string, unknown>): Promise<void> {
    const [kind, id] = (typeof data.aggregate === 'string' ? data.aggregate : '').split(':');
    if (kind === 'apiVersion' && id) await this.reconcileVersion(id);
  }

  /** Full pass: the gateway's TLS, every served version, then orphans. Errors are recorded. */
  async reconcileAll(): Promise<void> {
    try {
      await this.reconcileTls();
    } catch (error) {
      this.logger.warn(`APISIX TLS reconcile failed: ${String(error)}`);
    }
    try {
      await this.reconcileTokenRoute();
    } catch (error) {
      this.logger.warn(`APISIX token route reconcile failed: ${String(error)}`);
    }
    try {
      await this.reconcileNodeControlRoute();
    } catch (error) {
      this.logger.warn(`APISIX node control route reconcile failed: ${String(error)}`);
    }
    const versions = await this.prisma.apiVersion.findMany({
      where: { status: { in: [...SERVED] } },
      select: { id: true, api: { select: { entityId: true } } },
    });
    for (const v of versions) {
      try {
        await this.reconcileVersion(v.id);
      } catch (error) {
        this.logger.warn(`APISIX reconcile of version ${v.id} failed: ${String(error)}`);
      }
    }
    // Check routes (M4-06): those of versions in review, and none of any other version.
    try {
      const reviewing = await this.prisma.apiVersion.findMany({
        where: { status: 'in_review' },
        select: { id: true },
      });
      const keep = new Set(reviewing.map((v) => v.id));
      for (const v of reviewing) {
        await this.reconcileChecks(v.id, await this.loadVersion(v.id)).catch((error: unknown) =>
          this.logger.warn(`APISIX check routes of version ${v.id}: ${String(error)}`),
        );
      }
      const served = new Set(versions.map((v) => v.id));
      for (const id of await this.admin.list('routes')) {
        // Sandbox routes (M4-08) of versions no longer served.
        if (
          id.startsWith(SANDBOX_ROUTE_PREFIX) &&
          !served.has(id.slice(SANDBOX_ROUTE_PREFIX.length))
        ) {
          await this.admin.delete('routes', id);
          continue;
        }
        if (!id.startsWith(CHECK_ROUTE_PREFIX)) continue;
        const versionId = id.slice(CHECK_ROUTE_PREFIX.length).replace(/^sandbox-/, '');
        if (!keep.has(versionId)) await this.admin.delete('routes', id);
      }
    } catch (error) {
      this.logger.warn(`APISIX check routes cleanup failed: ${String(error)}`);
    }
    try {
      await this.removeOrphans(
        new Set(versions.map((v) => v.id)),
        new Set(versions.map((v) => v.api.entityId)),
      );
    } catch (error) {
      this.logger.warn(`APISIX orphan cleanup failed: ${String(error)}`);
    }
  }

  /**
   * Check routes of a version in review (M4-06): created while it is `in_review`, removed in any
   * other status. They take the token and the policy out of the way for the portal's validations,
   * so their builder (desiredCheckRoutes) keeps them narrow.
   */
  async reconcileChecks(
    apiVersionId: string,
    version: Awaited<ReturnType<typeof this.loadVersion>>,
  ): Promise<void> {
    const ids = [checkRouteId(apiVersionId), sandboxCheckRouteId(apiVersionId)];
    const desired =
      version?.status === 'in_review' && this.settings.validationToken
        ? await this.checkRoutesOf(version)
        : null;
    const wanted = new Map<string, ApisixObject>();
    if (desired) {
      wanted.set(ids[0] ?? '', desired.health);
      if (desired.sandbox) wanted.set(ids[1] ?? '', desired.sandbox);
    }
    for (const id of ids) {
      const route = wanted.get(id);
      if (route) await this.apply('routes', id, route);
      else if (await this.admin.get('routes', id)) await this.admin.delete('routes', id);
    }
  }

  private loadVersion(apiVersionId: string) {
    return this.prisma.apiVersion.findUnique({
      where: { id: apiVersionId },
      include: { api: { include: { entity: true } } },
    });
  }

  private async checkRoutesOf(version: NonNullable<Awaited<ReturnType<typeof this.loadVersion>>>) {
    const upstream = upstreamSchema.parse(version.upstream);
    const sandbox = version.sandboxUpstream ? upstreamSchema.parse(version.sandboxUpstream) : null;
    const entity = version.api.entity;
    const nodeOf = async (u: Upstream) =>
      u.type === 'node' && u.nodeId
        ? await this.prisma.node.findUnique({
            where: { id: u.nodeId },
            select: { id: true, entityId: true, status: true },
          })
        : undefined;
    const needsPki = [upstream, sandbox].some(
      (u) => u && needsGatewayPki(u, entity.slug, this.settings),
    );
    const pki = needsPki ? await this.reconcileClientTls(entity) : undefined;
    const base = {
      id: version.id,
      entityId: entity.id,
      basePath: version.basePath,
      methods: [],
      bodySubjects: [],
      hasDataSubjects: false,
      entitySlug: entity.slug,
      apiName: version.api.name,
      version: version.version,
      xroadMember:
        entity.xroadMemberClass && entity.xroadMemberCode
          ? { memberClass: entity.xroadMemberClass, memberCode: entity.xroadMemberCode }
          : null,
    };
    const forUpstream = async (u: Upstream) => {
      const addresses = await this.assertPublicUpstream(u);
      const node = await nodeOf(u);
      return {
        ...base,
        upstream: u,
        ...(addresses ? { addresses } : {}),
        ...(node !== undefined ? { node } : {}),
      };
    };
    const main = desiredCheckRoutes(
      { ...(await forUpstream(upstream)), sandboxUpstream: null },
      this.settings,
      pki,
    );
    if (!main) return null;
    if (!sandbox) return main;
    const withSandbox = desiredCheckRoutes(
      { ...(await forUpstream(sandbox)), upstream: sandbox, sandboxUpstream: sandbox },
      this.settings,
      pki,
    );
    return { health: main.health, sandbox: withSandbox?.sandbox ?? null };
  }

  /**
   * The sandbox route of a served version with a sandbox upstream (M4-08): the published route's
   * plugin chain (token, policy, limit, logs) under /sandbox, to the sandbox upstream (inline),
   * without the transparency register: its data is synthetic. Only sandbox applications pass OPA.
   */
  async reconcileSandbox(
    version: NonNullable<Awaited<ReturnType<typeof this.loadVersion>>>,
  ): Promise<void> {
    if (!version.sandboxUpstream) {
      await this.removeSandbox(version.id);
      return;
    }
    const sandbox = upstreamSchema.parse(version.sandboxUpstream);
    const entity = version.api.entity;
    const operations = listOperations(version.openapiSpec as Record<string, unknown>);
    const basePath = sandboxBasePath(version.basePath);
    const addresses = await this.assertPublicUpstream(sandbox);
    const node =
      sandbox.type === 'node' && sandbox.nodeId
        ? await this.prisma.node.findUnique({
            where: { id: sandbox.nodeId },
            select: { id: true, entityId: true, status: true },
          })
        : undefined;
    const pki = needsGatewayPki(sandbox, entity.slug, this.settings)
      ? await this.reconcileClientTls(entity)
      : undefined;
    const desired = desiredGateway(
      {
        id: version.id,
        entityId: entity.id,
        basePath,
        upstream: sandbox,
        ...(addresses ? { addresses } : {}),
        ...(node !== undefined ? { node } : {}),
        methods: operations.map((o) => o.method),
        hasDataSubjects: false,
        bodySubjects: operations.flatMap((o) =>
          o.dataSubject?.in === 'body'
            ? [
                {
                  method: o.method,
                  pathRegex: pathRegex(basePath, o.path),
                  pointer: o.dataSubject.pointer,
                  ...(o.dataSubject.documentTypePointer
                    ? { typePointer: o.dataSubject.documentTypePointer }
                    : {}),
                },
              ]
            : [],
        ),
        entitySlug: entity.slug,
        apiName: version.api.name,
        version: version.version,
        xroadMember:
          entity.xroadMemberClass && entity.xroadMemberCode
            ? { memberClass: entity.xroadMemberClass, memberCode: entity.xroadMemberCode }
            : null,
      },
      this.settings,
      pki,
    );
    const { upstream_id: _shared, ...route } = desired.route;
    await this.apply('routes', sandboxRouteId(version.id), {
      ...route,
      name: `sandbox ${typeof route.name === 'string' ? route.name : ''}`.slice(0, 100),
      labels: { ...(route.labels as Record<string, string>), 'rid-sandbox': 'true' },
      upstream: desired.upstream,
    });
  }

  private async removeSandbox(apiVersionId: string): Promise<void> {
    if (await this.admin.get('routes', sandboxRouteId(apiVersionId))) {
      await this.admin.delete('routes', sandboxRouteId(apiVersionId));
    }
  }

  /** Deletes managed routes and upstreams whose version is not served (route first). */
  private async removeOrphans(
    served: ReadonlySet<string>,
    providers: ReadonlySet<string>,
  ): Promise<void> {
    const managed = (ids: string[], prefix: string) =>
      ids
        .filter((id) => id.startsWith(`${MANAGED_PREFIX}${prefix}-`))
        .filter((id) => !served.has(id.slice(`${MANAGED_PREFIX}${prefix}-`.length)));
    for (const id of managed(await this.admin.list('routes'), 'route')) {
      await this.admin.delete('routes', id);
      this.logger.log(`Removed orphan APISIX route ${id}`);
    }
    for (const id of managed(await this.admin.list('upstreams'), 'upstream')) {
      await this.deleteUpstream(id);
      this.logger.log(`Removed orphan APISIX upstream ${id}`);
    }
    for (const id of await this.admin.list('ssls')) {
      if (!id.startsWith(MANAGED_PREFIX) || id === GATEWAY_SSL_ID) continue;
      // A provider's client identity stays while the provider serves some version.
      if (
        id.startsWith(GATEWAY_CLIENT_SSL_PREFIX) &&
        providers.has(id.slice(GATEWAY_CLIENT_SSL_PREFIX.length))
      ) {
        continue;
      }
      await this.admin.delete('ssls', id);
      this.logger.log(`Removed orphan APISIX SSL object ${id}`);
    }
  }

  /**
   * The gateway's client certificate towards the upstreams of one provider entity (M3-03), as an
   * SSL object of type client that its upstreams with mTLS reference by id: renewing it updates
   * one object, not every upstream. Returns the network CA, which verifies kit nodes.
   */
  /**
   * The SSL object of the gateway's client certificate towards the operator's X-Road Security
   * Server (M4-05, SPIKE S-5): one identity, CN=<RID_GATEWAY_CLIENT_NAME>.xroad, which the
   * operator registers in the Security Server as the internal TLS certificate of its subsystem.
   */
  async reconcileXroadTls(now = new Date()): Promise<void> {
    const target = `apisix:ssl:${GATEWAY_XROAD_SSL_ID}`;
    let desiredHash = hash(null);
    try {
      const certificate = await this.certificates.upstreamClient(
        `${this.settings.tls.clientName}.xroad`,
        now,
      );
      const desired = {
        type: 'client',
        cert: certificate.certificatePem,
        key: certificate.keyPem,
        labels: { 'rid-managed': 'true' },
        status: 1,
      };
      desiredHash = hash({ ...desired, key: certificate.fingerprint });
      const actual = await this.admin.get('ssls', GATEWAY_XROAD_SSL_ID);
      if (!actual || !sslMatches(desired, actual)) {
        await this.admin.put('ssls', GATEWAY_XROAD_SSL_ID, desired);
      }
      await this.recordSuccess(target, desiredHash);
    } catch (error) {
      await this.recordError(target, desiredHash, error);
      throw error;
    }
  }

  async reconcileClientTls(
    entity: { id: string; slug: string },
    now = new Date(),
  ): Promise<UpstreamPki> {
    const sslId = gatewayClientSslId(entity.id);
    const target = gatewayClientTlsSyncTarget(entity.id);
    let desiredHash = hash(null);
    try {
      const certificate = await this.certificates.upstreamClient(
        gatewayClientName(this.settings, entity.slug),
        now,
      );
      const desired = {
        type: 'client',
        cert: certificate.certificatePem,
        key: certificate.keyPem,
        labels: { 'rid-managed': 'true' },
        status: 1,
      };
      desiredHash = hash({ ...desired, key: certificate.fingerprint });
      const actual = await this.admin.get('ssls', sslId);
      if (!actual || !sslMatches(desired, actual)) {
        await this.admin.put('ssls', sslId, desired);
      }
      await this.recordSuccess(target, desiredHash);
      return { networkCaPem: certificate.networkCaPem };
    } catch (error) {
      await this.recordError(target, desiredHash, error);
      throw error;
    }
  }

  /**
   * The gateway's SSL object (S-3, M3-02): its server certificate, issued and renewed through
   * step-ca, and with features.mtls.required the network CA as `client.ca`.
   */
  async reconcileTls(now = new Date()): Promise<'created' | 'updated' | 'unchanged'> {
    let desiredHash = hash(null);
    try {
      const certificate = await this.certificates.server(this.settings.tls.hosts, now);
      const desired = desiredSsl(certificate, this.settings);
      desiredHash = hash({ ...desired, key: certificate.fingerprint });
      const actual = await this.admin.get('ssls', GATEWAY_SSL_ID);
      let result: 'created' | 'updated' | 'unchanged' = 'unchanged';
      if (!actual || !sslMatches(desired, actual)) {
        await this.admin.put('ssls', GATEWAY_SSL_ID, desired);
        result = actual ? 'updated' : 'created';
      }
      await this.recordSuccess(GATEWAY_TLS_SYNC_TARGET, desiredHash);
      return result;
    } catch (error) {
      await this.recordError(GATEWAY_TLS_SYNC_TARGET, desiredHash, error);
      throw error;
    }
  }

  /**
   * The gateway's route to the rid-gateway token endpoint (S-4, M3-10): applications get their
   * token over the TLS where APISIX verified their certificate, and Keycloak binds it to it.
   */
  async reconcileTokenRoute(): Promise<'created' | 'updated' | 'unchanged'> {
    const desired = desiredTokenRoute(this.settings);
    const desiredHash = hash(desired);
    try {
      const actual = await this.admin.get('routes', TOKEN_ROUTE_ID);
      let result: 'created' | 'updated' | 'unchanged' = 'unchanged';
      if (!actual || !matches(desired, actual)) {
        await this.admin.put('routes', TOKEN_ROUTE_ID, desired);
        result = actual ? 'updated' : 'created';
      }
      await this.recordSuccess(GATEWAY_TOKEN_SYNC_TARGET, desiredHash);
      return result;
    } catch (error) {
      await this.recordError(GATEWAY_TOKEN_SYNC_TARGET, desiredHash, error);
      throw error;
    }
  }

  /**
   * The control channel of kit nodes (M4-02). Without RID_GATEWAY_PORTAL_API_URL and
   * RID_NODE_CONTROL_TOKEN the route is removed: nodes cannot reach the portal.
   */
  async reconcileNodeControlRoute(): Promise<GatewayResult> {
    const desired = desiredNodeControlRoute(this.settings);
    // The token is part of the route: hash it, never store it in sync_state.
    const desiredHash = hash(desired);
    try {
      const actual = await this.admin.get('routes', NODE_CONTROL_ROUTE_ID);
      let result: GatewayResult = actual ? 'unchanged' : 'absent';
      if (!desired) {
        if (actual) {
          await this.admin.delete('routes', NODE_CONTROL_ROUTE_ID);
          result = 'deleted';
        }
      } else if (!actual || !matches(desired, actual)) {
        await this.admin.put('routes', NODE_CONTROL_ROUTE_ID, desired);
        result = actual ? 'updated' : 'created';
      }
      await this.recordSuccess(NODE_CONTROL_SYNC_TARGET, desiredHash);
      return result;
    } catch (error) {
      await this.recordError(NODE_CONTROL_SYNC_TARGET, desiredHash, error);
      throw error;
    }
  }

  async reconcileVersion(apiVersionId: string): Promise<GatewayResult> {
    const version = await this.loadVersion(apiVersionId);
    const target = gatewaySyncTarget(apiVersionId);
    const served = version && (SERVED as readonly string[]).includes(version.status);
    let desiredHash = hash(null);
    // Check routes of a version in review (M4-06), on their own: they never block the route.
    await this.reconcileChecks(apiVersionId, version).catch((error: unknown) =>
      this.logger.warn(`APISIX check routes of version ${apiVersionId}: ${String(error)}`),
    );

    try {
      if (!served) {
        await this.removeSandbox(apiVersionId);
        const existed = await this.removeVersion(apiVersionId);
        if (version) await this.recordSuccess(target, desiredHash);
        return existed ? 'deleted' : 'absent';
      }

      const upstreamConfig = upstreamSchema.parse(version.upstream);
      // The kit node of the version, as stored now (M4-04): its entity and state decide.
      const node =
        upstreamConfig.type === 'node' && upstreamConfig.nodeId
          ? await this.prisma.node.findUnique({
              where: { id: upstreamConfig.nodeId },
              select: { id: true, entityId: true, status: true },
            })
          : undefined;
      const operations = listOperations(version.openapiSpec as Record<string, unknown>);
      const addresses = await this.assertPublicUpstream(upstreamConfig);
      // Only upstreams with mTLS depend on step-ca: the others keep working if the CA is down.
      const pki = needsGatewayPki(upstreamConfig, version.api.entity.slug, this.settings)
        ? await this.reconcileClientTls(version.api.entity)
        : undefined;
      // X-Road over HTTPS: the gateway's own certificate towards the Security Server (M4-05).
      if (
        upstreamConfig.type === 'xroad' &&
        this.settings.xroad?.securityServerUrl.startsWith('https:')
      ) {
        await this.reconcileXroadTls();
      }
      const desired = desiredGateway(
        {
          id: version.id,
          entityId: version.api.entityId,
          basePath: version.basePath,
          upstream: upstreamConfig,
          ...(addresses ? { addresses } : {}),
          methods: operations.map((o) => o.method),
          hasDataSubjects: operations.some(
            (o) => o.dataSubject?.in === 'path' || o.dataSubject?.in === 'body',
          ),
          bodySubjects: operations.flatMap((o) =>
            o.dataSubject?.in === 'body'
              ? [
                  {
                    method: o.method,
                    pathRegex: pathRegex(version.basePath, o.path),
                    pointer: o.dataSubject.pointer,
                    ...(o.dataSubject.documentTypePointer
                      ? { typePointer: o.dataSubject.documentTypePointer }
                      : {}),
                  },
                ]
              : [],
          ),
          entitySlug: version.api.entity.slug,
          ...(node !== undefined ? { node } : {}),
          xroadMember:
            version.api.entity.xroadMemberClass && version.api.entity.xroadMemberCode
              ? {
                  memberClass: version.api.entity.xroadMemberClass,
                  memberCode: version.api.entity.xroadMemberCode,
                }
              : null,
          apiName: version.api.name,
          version: version.version,
          ...(version.status === 'deprecated' && version.deprecatedAt && version.sunsetAt
            ? { deprecation: { deprecatedAt: version.deprecatedAt, sunsetAt: version.sunsetAt } }
            : {}),
        },
        this.settings,
        pki,
      );
      desiredHash = hash(desired);

      // Upstream before route: the route references it.
      const upstream = await this.apply('upstreams', upstreamId(apiVersionId), desired.upstream);
      const route = await this.apply('routes', routeId(apiVersionId), desired.route);
      await this.recordSuccess(target, desiredHash);
      // The version's sandbox (M4-08), on its own: it never blocks the real route.
      await this.reconcileSandbox(version).catch((error: unknown) =>
        this.logger.warn(`APISIX sandbox route of version ${apiVersionId}: ${String(error)}`),
      );
      if (upstream === 'created' || route === 'created') return 'created';
      if (upstream === 'updated' || route === 'updated') return 'updated';
      return 'unchanged';
    } catch (error) {
      // A version the gateway must not serve (invalid or internal upstream) loses whatever it had
      // in APISIX: fail closed instead of leaving an older route working.
      if (error instanceof UnsupportedUpstreamError || error instanceof ZodError) {
        await this.removeVersion(apiVersionId).catch((cleanup: unknown) =>
          this.logger.error(
            `Could not remove version ${apiVersionId} from APISIX: ${String(cleanup)}`,
          ),
        );
      }
      await this.recordError(target, desiredHash, error);
      throw error;
    }
  }

  /**
   * SSRF guard at reconcile time: every address a direct upstream's host resolves to must be
   * public (the name itself was checked at registration). A lookup failure is not evidence of an
   * attack, so it is reported without removing a working route.
   */
  private async assertPublicUpstream(upstream: Upstream): Promise<string[] | undefined> {
    if (upstream.type !== 'direct') return undefined;
    const host = new URL(upstream.url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return [host]; // literal IPs are fully judged by isPublicHostname
    const addresses = await this.settings.resolveHost(host);
    const internal = addresses.filter((address) => !isPublicAddress(address));
    if (addresses.length === 0 || internal.length > 0) {
      throw new UnsupportedUpstreamError(
        `Upstream host ${host} resolves to non-public addresses (${internal.join(', ') || 'none'})`,
      );
    }
    return addresses;
  }

  private async apply(
    kind: 'routes' | 'upstreams',
    id: string,
    desired: Record<string, unknown>,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const actual = await this.admin.get(kind, id);
    if (actual && matches(desired, actual)) return 'unchanged';
    await this.admin.put(kind, id, desired);
    return actual ? 'updated' : 'created';
  }

  /** Route first, then upstream (APISIX refuses to delete an upstream still in use). */
  private async removeVersion(apiVersionId: string): Promise<boolean> {
    const route = await this.admin.get('routes', routeId(apiVersionId));
    const upstream = await this.admin.get('upstreams', upstreamId(apiVersionId));
    if (route) await this.admin.delete('routes', routeId(apiVersionId));
    if (upstream) await this.deleteUpstream(upstreamId(apiVersionId));
    return Boolean(route || upstream);
  }

  /**
   * APISIX checks that no route uses an upstream against its own config cache, which follows etcd
   * with a short delay: right after deleting the route it may still refuse. Retry only that case.
   */
  private deleteUpstream(id: string): Promise<void> {
    return deleteUpstreamWhenUnused(this.admin, id);
  }

  private async recordSuccess(target: string, desiredHash: string): Promise<void> {
    const now = new Date();
    await this.prisma.syncState.upsert({
      where: { target },
      create: {
        target,
        system: 'apisix',
        desiredHash,
        appliedHash: desiredHash,
        status: 'in_sync',
        appliedAt: now,
      },
      update: {
        desiredHash,
        appliedHash: desiredHash,
        status: 'in_sync',
        appliedAt: now,
        lastError: null,
        attempts: 0,
      },
    });
  }

  private async recordError(target: string, desiredHash: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await this.prisma.syncState.upsert({
      where: { target },
      create: {
        target,
        system: 'apisix',
        desiredHash,
        status: 'error',
        lastError: message,
        attempts: 1,
      },
      update: { desiredHash, status: 'error', lastError: message, attempts: { increment: 1 } },
    });
  }
}
