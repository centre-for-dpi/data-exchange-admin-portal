import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { isIP } from 'node:net';
import { isPublicAddress, type Upstream, upstreamSchema } from '@den/contracts';
import { ZodError } from 'zod';
import { listOperations } from '../../apis/lint/openapi-lint.js';
import { pathRegex } from '../../opa/bundle.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { isDrift, recordSyncSuccess } from '../sync-state.js';
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
  ROUTE_PREFIX,
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
import { GatewaySigningKeysService } from '../../assertion/gateway-signing-keys.service.js';
import { GatewayCertificates } from './gateway-certificates.js';
import { GATEWAY_SYNC_TOPIC } from './topics.js';

export { GATEWAY_SYNC_TOPIC } from './topics.js';
export const APISIX_SETTINGS = Symbol('APISIX_SETTINGS');
const FULL_RECONCILE_MS = 5 * 60 * 1000;
/**
 * Serializes the reconciler's units of work across API replicas ("den_apsx"): see serialized().
 * Exported for the integration test that holds it.
 */
export const APISIX_RECONCILE_LOCK = 0x7269645f61707378n;
/** Lifetime of a unit's transaction, which holds the lock (waiting for it included). */
const UNIT_TIMEOUT_MS = 120_000;
/** Time to get a database connection for that transaction. */
const UNIT_MAX_WAIT_MS = 30_000;

/** Versions the gateway serves: deprecated ones keep working until they are retired. */
const SERVED = ['published', 'deprecated'] as const;

export type GatewayResult = 'created' | 'updated' | 'unchanged' | 'deleted' | 'absent';

export const gatewaySyncTarget = (apiVersionId: string): string =>
  `apisix:route:${routeId(apiVersionId)}`;
export const GATEWAY_TLS_SYNC_TARGET = `apisix:ssl:${GATEWAY_SSL_ID}`;
const ASSERTION_PLUGIN = 'den-assertion';
export const ASSERTION_SYNC_TARGET = `apisix:plugin_metadata:${ASSERTION_PLUGIN}`;
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
 * also removes `den-` objects nothing in the database asks for. Objects without the prefix are
 * never touched.
 *
 * Every unit of work (one version, one gateway object, the orphan cleanup) runs under one
 * PostgreSQL advisory lock, shared by the outbox jobs and the full passes of every replica: a
 * unit reads the database and writes APISIX with no other unit in between, so a pass can neither
 * delete what a job created while it ran nor write back a state a later job removed (M-09).
 */
@Injectable()
export class ApisixReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ApisixReconciler.name);
  private timer?: NodeJS.Timeout;
  /** Set while the current call chain holds the lock (units call other units). */
  private readonly holding = new AsyncLocalStorage<true>();
  /** The full pass in progress in this process, and whether another one was asked for meanwhile. */
  private pass?: Promise<void>;
  private passAgain = false;
  /**
   * The objects with a private key (SSL objects, the assertion key) written since this process
   * started. Each is written once even when it matches (B-31): APISIX encrypts it with the first
   * key of its keyring, the deployment's own, so nothing stays under a key that left the keyring
   * (APISIX's public factory key, removed from infra/apisix/config.yaml).
   */
  private readonly reencrypted = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(APISIX_ADMIN) private readonly admin: ApisixAdmin,
    @Inject(APISIX_SETTINGS) private readonly settings: GatewaySettings,
    private readonly certificates: GatewayCertificates,
    private readonly signingKeys: GatewaySigningKeysService,
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

  /** An object with a private key not yet written by this process (see `reencrypted`). */
  private mustReencrypt(id: string): boolean {
    return !this.reencrypted.has(id);
  }

  async handle(data: Record<string, unknown>): Promise<void> {
    const [kind, id] = (typeof data.aggregate === 'string' ? data.aggregate : '').split(':');
    if (kind === 'apiVersion' && id) await this.reconcileVersion(id);
    // The operator's retry of the gateway's own objects (TLS, token and control routes): M5-07.
    if (kind === 'gateway' && id === 'all') await this.reconcileAll();
  }

  /**
   * Runs `work` holding the reconciler's advisory lock, inside a transaction that only holds it
   * (the work queries with its own connections). Re-entrant: a unit that calls another one keeps
   * the lock it has.
   */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    if (this.holding.getStore()) return work();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${APISIX_RECONCILE_LOCK})`;
        return this.holding.run(true, work);
      },
      { timeout: UNIT_TIMEOUT_MS, maxWait: UNIT_MAX_WAIT_MS },
    );
  }

  /**
   * Full pass: the gateway's TLS, every served version, then orphans. Errors are recorded. One
   * pass at a time per process: a call while one runs waits for it and for one more pass after
   * it, which sees whatever changed meanwhile.
   */
  reconcileAll(): Promise<void> {
    if (this.pass) {
      this.passAgain = true;
      return this.pass;
    }
    const run = async () => {
      try {
        do {
          this.passAgain = false;
          await this.fullPass();
        } while (this.passAgain);
      } finally {
        this.pass = undefined;
      }
    };
    this.pass = run();
    return this.pass;
  }

  private async fullPass(): Promise<void> {
    try {
      await this.reconcileTls();
    } catch (error) {
      this.logger.warn(`APISIX TLS reconcile failed: ${String(error)}`);
    }
    // The signing key before the routes that use it (M6-10).
    try {
      await this.reconcileAssertionKey();
    } catch (error) {
      this.logger.warn(`APISIX assertion key reconcile failed: ${String(error)}`);
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
    let reviewing: Array<{ id: string }> = [];
    try {
      reviewing = await this.prisma.apiVersion.findMany({
        where: { status: 'in_review' },
        select: { id: true },
      });
      for (const v of reviewing) {
        await this.serialized(async () =>
          this.reconcileChecks(v.id, await this.loadVersion(v.id)),
        ).catch((error: unknown) =>
          this.logger.warn(`APISIX check routes of version ${v.id}: ${String(error)}`),
        );
      }
    } catch (error) {
      this.logger.warn(`APISIX check routes reconcile failed: ${String(error)}`);
    }
    try {
      await this.removeOrphans(
        new Set(versions.map((v) => v.id)),
        new Set(reviewing.map((v) => v.id)),
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
  reconcileChecks(
    apiVersionId: string,
    version: Awaited<ReturnType<typeof this.loadVersion>>,
  ): Promise<void> {
    return this.serialized(() => this.applyChecks(apiVersionId, version));
  }

  private async applyChecks(
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
    const pki = await this.ensureUpstreamTls(sandbox ? [upstream, sandbox] : [upstream], entity);
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
    const pki = await this.ensureUpstreamTls([sandbox], entity);
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
      labels: { ...(route.labels as Record<string, string>), 'den-sandbox': 'true' },
      upstream: desired.upstream,
    });
  }

  private async removeSandbox(apiVersionId: string): Promise<void> {
    if (await this.admin.get('routes', sandboxRouteId(apiVersionId))) {
      await this.admin.delete('routes', sandboxRouteId(apiVersionId));
    }
  }

  /**
   * Deletes the managed objects nothing in the database asks for, in one unit of work: routes
   * before upstreams (route first), then SSL objects. `served` and `reviewing` are the versions
   * the pass listed when it started; a candidate outside them is read again here, under the lock,
   * and kept if it is served (or in review) now (M-09).
   */
  private removeOrphans(served: ReadonlySet<string>, reviewing: ReadonlySet<string>) {
    return this.serialized(async () => {
      const now = new Map<string, string | undefined>();
      const statusNow = async (id: string) => {
        if (!now.has(id)) {
          const row = await this.prisma.apiVersion.findUnique({
            where: { id },
            select: { status: true },
          });
          now.set(id, row?.status);
        }
        return now.get(id);
      };
      const isServed = async (id: string) =>
        served.has(id) || (SERVED as readonly string[]).includes((await statusNow(id)) ?? '');
      const inReview = async (id: string) =>
        reviewing.has(id) || (await statusNow(id)) === 'in_review';

      for (const id of await this.admin.list('routes')) {
        // Published routes and sandbox routes (M4-08) of versions no longer served.
        const version = id.startsWith(ROUTE_PREFIX)
          ? id.slice(ROUTE_PREFIX.length)
          : id.startsWith(SANDBOX_ROUTE_PREFIX)
            ? id.slice(SANDBOX_ROUTE_PREFIX.length)
            : undefined;
        // Check routes (M4-06) of versions no longer in review.
        const checked = id.startsWith(CHECK_ROUTE_PREFIX)
          ? id.slice(CHECK_ROUTE_PREFIX.length).replace(/^sandbox-/, '')
          : undefined;
        let keep = true;
        if (version !== undefined) keep = await isServed(version);
        else if (checked !== undefined) keep = await inReview(checked);
        if (keep) continue;
        await this.admin.delete('routes', id);
        this.logger.log(`Removed orphan APISIX route ${id}`);
      }
      const upstreamPrefix = upstreamId('');
      for (const id of await this.admin.list('upstreams')) {
        if (!id.startsWith(upstreamPrefix)) continue;
        if (await isServed(id.slice(upstreamPrefix.length))) continue;
        await this.deleteUpstream(id);
        this.logger.log(`Removed orphan APISIX upstream ${id}`);
      }
      // SSL objects: exactly the ones the versions in the database need now (A-5, M-10).
      const desired = await this.desiredSsls();
      for (const id of await this.admin.list('ssls')) {
        if (!id.startsWith(MANAGED_PREFIX) || desired.has(id)) continue;
        await this.admin.delete('ssls', id);
        this.logger.log(`Removed orphan APISIX SSL object ${id}`);
      }
    });
  }

  /** Whether xroad upstreams reach the operator's Security Server over TLS (M4-05). */
  private xroadOverTls(): boolean {
    return this.settings.xroad?.securityServerUrl.startsWith('https:') ?? false;
  }

  /**
   * The SSL objects an upstream presents: the provider entity's client certificate (direct with
   * mTLS, nodes over TLS) or the gateway's X-Road certificate (xroad over HTTPS).
   */
  private sslsOf(upstream: Upstream, entity: { id: string; slug: string }): string[] {
    return [
      ...(needsGatewayPki(upstream, entity.slug, this.settings)
        ? [gatewayClientSslId(entity.id)]
        : []),
      ...(upstream.type === 'xroad' && this.xroadOverTls() ? [GATEWAY_XROAD_SSL_ID] : []),
    ];
  }

  /**
   * Ensures the SSL objects these upstreams of one entity present, before an upstream that
   * references them is written. Only upstreams with TLS towards them depend on step-ca: the others
   * keep working if the CA is down. Returns the network CA when the entity's PKI was needed.
   */
  private async ensureUpstreamTls(
    upstreams: Upstream[],
    entity: { id: string; slug: string },
  ): Promise<UpstreamPki | undefined> {
    const needed = new Set(upstreams.flatMap((u) => this.sslsOf(u, entity)));
    // X-Road over HTTPS: the gateway's own certificate towards the Security Server (M4-05).
    if (needed.has(GATEWAY_XROAD_SSL_ID)) await this.reconcileXroadTls();
    return needed.has(gatewayClientSslId(entity.id))
      ? await this.reconcileClientTls(entity)
      : undefined;
  }

  /**
   * The SSL objects the gateway must hold, from the database: its own TLS, and those the
   * upstreams and sandbox upstreams of served versions, and of versions in review when they have
   * check routes, present (sslsOf).
   */
  private async desiredSsls(): Promise<Set<string>> {
    const statuses: Array<(typeof SERVED)[number] | 'in_review'> = [
      ...SERVED,
      ...(this.settings.validationToken ? (['in_review'] as const) : []),
    ];
    const versions = await this.prisma.apiVersion.findMany({
      where: { status: { in: statuses } },
      select: {
        upstream: true,
        sandboxUpstream: true,
        api: { select: { entityId: true, entity: { select: { slug: true } } } },
      },
    });
    const desired = new Set([GATEWAY_SSL_ID]);
    for (const v of versions) {
      const entity = { id: v.api.entityId, slug: v.api.entity.slug };
      for (const raw of [v.upstream, v.sandboxUpstream]) {
        const parsed = raw ? upstreamSchema.safeParse(raw) : undefined;
        if (parsed?.success) for (const id of this.sslsOf(parsed.data, entity)) desired.add(id);
      }
    }
    return desired;
  }

  /**
   * The SSL object of the gateway's client certificate towards the operator's X-Road Security
   * Server (M4-05, SPIKE S-5): one identity, CN=<DEN_GATEWAY_CLIENT_NAME>.xroad, which the
   * operator registers in the Security Server as the internal TLS certificate of its subsystem.
   */
  reconcileXroadTls(now = new Date()): Promise<void> {
    return this.serialized(() => this.applyXroadTls(now));
  }

  private async applyXroadTls(now: Date): Promise<void> {
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
        labels: { 'den-managed': 'true' },
        status: 1,
      };
      desiredHash = hash({ ...desired, key: certificate.fingerprint });
      const actual = await this.admin.get('ssls', GATEWAY_XROAD_SSL_ID);
      if (!actual || !sslMatches(desired, actual) || this.mustReencrypt(GATEWAY_XROAD_SSL_ID)) {
        await this.admin.put('ssls', GATEWAY_XROAD_SSL_ID, desired);
        this.reencrypted.add(GATEWAY_XROAD_SSL_ID);
      }
      await this.recordSuccess(target, desiredHash);
    } catch (error) {
      await this.recordError(target, desiredHash, error);
      throw error;
    }
  }

  /**
   * The gateway's client certificate towards the upstreams of one provider entity (M3-03), as an
   * SSL object of type client that its upstreams with mTLS reference by id: renewing it updates
   * one object, not every upstream. Returns the network CA, which verifies kit nodes.
   */
  reconcileClientTls(entity: { id: string; slug: string }, now = new Date()): Promise<UpstreamPki> {
    return this.serialized(() => this.applyClientTls(entity, now));
  }

  private async applyClientTls(
    entity: { id: string; slug: string },
    now: Date,
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
        labels: { 'den-managed': 'true' },
        status: 1,
      };
      desiredHash = hash({ ...desired, key: certificate.fingerprint });
      const actual = await this.admin.get('ssls', sslId);
      if (!actual || !sslMatches(desired, actual) || this.mustReencrypt(sslId)) {
        await this.admin.put('ssls', sslId, desired);
        this.reencrypted.add(sslId);
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
  reconcileTls(now = new Date()): Promise<'created' | 'updated' | 'unchanged'> {
    return this.serialized(() => this.applyTls(now));
  }

  private async applyTls(now: Date): Promise<'created' | 'updated' | 'unchanged'> {
    let desiredHash = hash(null);
    try {
      const certificate = await this.certificates.server(this.settings.tls.hosts, now);
      const desired = desiredSsl(certificate, this.settings);
      desiredHash = hash({ ...desired, key: certificate.fingerprint });
      const actual = await this.admin.get('ssls', GATEWAY_SSL_ID);
      let result: 'created' | 'updated' | 'unchanged' = 'unchanged';
      if (!actual || !sslMatches(desired, actual) || this.mustReencrypt(GATEWAY_SSL_ID)) {
        await this.admin.put('ssls', GATEWAY_SSL_ID, desired);
        this.reencrypted.add(GATEWAY_SSL_ID);
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
   * The signing key of the gateway's assertions (ADR-0024, M6-10) in den-assertion's metadata,
   * shared by every route: the current one of GatewaySigningKeysService, which also rotates it.
   * APISIX keeps the private key encrypted in etcd (encrypt_fields) and never returns it in
   * clear, so the comparison is by issuer and kid. With the feature off, the metadata is removed:
   * no private key stays in etcd for nothing.
   */
  reconcileAssertionKey(now = new Date()): Promise<GatewayResult> {
    return this.serialized(() => this.applyAssertionKey(now));
  }

  private async applyAssertionKey(now: Date): Promise<GatewayResult> {
    let desiredHash = hash(null);
    try {
      const actual = await this.admin.get('plugin_metadata', ASSERTION_PLUGIN);
      const assertion = this.settings.assertion;
      if (!assertion) {
        if (actual) await this.admin.delete('plugin_metadata', ASSERTION_PLUGIN);
        await this.recordSuccess(ASSERTION_SYNC_TARGET, desiredHash);
        return actual ? 'deleted' : 'absent';
      }
      const key = await this.signingKeys.current(now);
      desiredHash = hash({ issuer: assertion.issuer, kid: key.kid });
      let result: GatewayResult = 'unchanged';
      if (
        !actual ||
        actual.issuer !== assertion.issuer ||
        actual.kid !== key.kid ||
        this.mustReencrypt(ASSERTION_PLUGIN)
      ) {
        await this.admin.put('plugin_metadata', ASSERTION_PLUGIN, {
          issuer: assertion.issuer,
          kid: key.kid,
          private_key: key.privateKeyPem,
        });
        this.reencrypted.add(ASSERTION_PLUGIN);
        result = actual ? 'updated' : 'created';
      }
      await this.recordSuccess(ASSERTION_SYNC_TARGET, desiredHash);
      return result;
    } catch (error) {
      await this.recordError(ASSERTION_SYNC_TARGET, desiredHash, error);
      throw error;
    }
  }

  /**
   * The gateway's route to the den-gateway token endpoint (S-4, M3-10): applications get their
   * token over the TLS where APISIX verified their certificate, and Keycloak binds it to it.
   */
  reconcileTokenRoute(): Promise<'created' | 'updated' | 'unchanged'> {
    return this.serialized(() => this.applyTokenRoute());
  }

  private async applyTokenRoute(): Promise<'created' | 'updated' | 'unchanged'> {
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
   * The control channel of kit nodes (M4-02). Without DEN_GATEWAY_PORTAL_API_URL and
   * DEN_NODE_CONTROL_TOKEN the route is removed: nodes cannot reach the portal.
   */
  reconcileNodeControlRoute(): Promise<GatewayResult> {
    return this.serialized(() => this.applyNodeControlRoute());
  }

  private async applyNodeControlRoute(): Promise<GatewayResult> {
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

  reconcileVersion(apiVersionId: string): Promise<GatewayResult> {
    return this.serialized(() => this.applyVersion(apiVersionId));
  }

  private async applyVersion(apiVersionId: string): Promise<GatewayResult> {
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
      // The client certificate (mTLS) or the X-Road one the upstream presents, before it.
      const pki = await this.ensureUpstreamTls([upstreamConfig], version.api.entity);
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

      const previous = await this.prisma.syncState.findUnique({ where: { target } });
      // Upstream before route: the route references it.
      const upstream = await this.apply('upstreams', upstreamId(apiVersionId), desired.upstream);
      const route = await this.apply('routes', routeId(apiVersionId), desired.route);
      const wrote = upstream !== 'unchanged' || route !== 'unchanged';
      await this.recordSuccess(target, desiredHash, isDrift(previous, desiredHash, wrote));
      // The version's sandbox (M4-08), on its own: it never blocks the real route, but a sandbox
      // the gateway must not serve loses its route (fail closed, like the real one).
      await this.reconcileSandbox(version).catch(async (error: unknown) => {
        this.logger.warn(`APISIX sandbox route of version ${apiVersionId}: ${String(error)}`);
        if (error instanceof UnsupportedUpstreamError || error instanceof ZodError) {
          await this.removeSandbox(apiVersionId).catch(() => undefined);
        }
      });
      if (upstream === 'created' || route === 'created') return 'created';
      if (upstream === 'updated' || route === 'updated') return 'updated';
      return 'unchanged';
    } catch (error) {
      // A version the gateway must not serve (invalid or internal upstream) loses whatever it had
      // in APISIX: fail closed instead of leaving an older route working.
      if (error instanceof UnsupportedUpstreamError || error instanceof ZodError) {
        await this.removeSandbox(apiVersionId).catch(() => undefined);
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

  private async recordSuccess(target: string, desiredHash: string, drift = false): Promise<void> {
    if (drift) this.logger.warn(`APISIX drift on ${target}: put back to the desired state`);
    await recordSyncSuccess(this.prisma, 'apisix', target, desiredHash, drift);
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
