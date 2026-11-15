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
import { APISIX_ADMIN, type ApisixAdmin, deleteUpstreamWhenUnused } from './apisix-admin.js';
import {
  desiredGateway,
  desiredSsl,
  GATEWAY_CLIENT_SSL_ID,
  GATEWAY_SSL_ID,
  type GatewaySettings,
  MANAGED_PREFIX,
  matches,
  needsGatewayPki,
  type UpstreamPki,
  routeId,
  sslMatches,
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
export const GATEWAY_CLIENT_TLS_SYNC_TARGET = `apisix:ssl:${GATEWAY_CLIENT_SSL_ID}`;
const GATEWAY_SSL_IDS = new Set([GATEWAY_SSL_ID, GATEWAY_CLIENT_SSL_ID]);

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
    const versions = await this.prisma.apiVersion.findMany({
      where: { status: { in: [...SERVED] } },
      select: { id: true },
    });
    for (const v of versions) {
      try {
        await this.reconcileVersion(v.id);
      } catch (error) {
        this.logger.warn(`APISIX reconcile of version ${v.id} failed: ${String(error)}`);
      }
    }
    try {
      await this.removeOrphans(new Set(versions.map((v) => v.id)));
    } catch (error) {
      this.logger.warn(`APISIX orphan cleanup failed: ${String(error)}`);
    }
  }

  /** Deletes managed routes and upstreams whose version is not served (route first). */
  private async removeOrphans(served: ReadonlySet<string>): Promise<void> {
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
      if (!id.startsWith(MANAGED_PREFIX) || GATEWAY_SSL_IDS.has(id)) continue;
      await this.admin.delete('ssls', id);
      this.logger.log(`Removed orphan APISIX SSL object ${id}`);
    }
  }

  /**
   * The gateway's client certificate towards upstreams (M3-03), as an SSL object of type client
   * that upstreams with mTLS reference by id: renewing it updates one object, not every upstream.
   * Returns the network CA, which verifies kit nodes.
   */
  async reconcileClientTls(now = new Date()): Promise<UpstreamPki> {
    let desiredHash = hash(null);
    try {
      const certificate = await this.certificates.upstreamClient(this.settings.tls.clientName, now);
      const desired = {
        type: 'client',
        cert: certificate.certificatePem,
        key: certificate.keyPem,
        labels: { 'rid-managed': 'true' },
        status: 1,
      };
      desiredHash = hash({ ...desired, key: certificate.fingerprint });
      const actual = await this.admin.get('ssls', GATEWAY_CLIENT_SSL_ID);
      if (!actual || !sslMatches(desired, actual)) {
        await this.admin.put('ssls', GATEWAY_CLIENT_SSL_ID, desired);
      }
      await this.recordSuccess(GATEWAY_CLIENT_TLS_SYNC_TARGET, desiredHash);
      return { networkCaPem: certificate.networkCaPem };
    } catch (error) {
      await this.recordError(GATEWAY_CLIENT_TLS_SYNC_TARGET, desiredHash, error);
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

  async reconcileVersion(apiVersionId: string): Promise<GatewayResult> {
    const version = await this.prisma.apiVersion.findUnique({
      where: { id: apiVersionId },
      include: { api: { include: { entity: true } } },
    });
    const target = gatewaySyncTarget(apiVersionId);
    const served = version && (SERVED as readonly string[]).includes(version.status);
    let desiredHash = hash(null);

    try {
      if (!served) {
        const existed = await this.removeVersion(apiVersionId);
        if (version) await this.recordSuccess(target, desiredHash);
        return existed ? 'deleted' : 'absent';
      }

      const upstreamConfig = upstreamSchema.parse(version.upstream);
      const operations = listOperations(version.openapiSpec as Record<string, unknown>);
      const addresses = await this.assertPublicUpstream(upstreamConfig);
      // Only upstreams with mTLS depend on step-ca: the others keep working if the CA is down.
      const pki = needsGatewayPki(upstreamConfig, version.api.entity.slug, this.settings)
        ? await this.reconcileClientTls()
        : undefined;
      const desired = desiredGateway(
        {
          id: version.id,
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
