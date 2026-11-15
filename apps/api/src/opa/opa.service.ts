import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import { USABLE_CREDENTIAL_STATUSES } from '../domain/credential/state-machine.js';
import { listOperations } from '../apis/lint/openapi-lint.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { routeId } from '../reconcilers/apisix/desired-state.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';
import {
  type BuiltBundle,
  type BundleClient,
  type BundleData,
  buildBundle,
  bundleSubject,
  pathRegex,
} from './bundle.js';
import { readPolicies } from './policy-files.js';

/** sync_state target of the OPA bundle: desired = latest revision, applied = active in OPA. */
export const OPA_SYNC_TARGET = 'opa:bundle';
const SERVED_VERSIONS = ['published', 'deprecated'] as const;
/** Subscriptions the gateway lets through; `approved` ones become `active` once OPA has them. */
const GRANTED = ['approved', 'active'] as const;
const KEEP_REVISIONS_MS = 24 * 60 * 60 * 1000;

export class BundleUnavailableError extends Error {}

/**
 * Builds the OPA bundle from PostgreSQL (ARCHITECTURE.md §4.2) and turns approved subscriptions
 * into active ones when OPA reports that the revision containing them is active. The portal never
 * pushes to OPA: OPA polls the bundle and reports its status.
 */
@Injectable()
export class OpaService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OpaService.name);
  private readonly policies = readPolicies();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(POLICY_SYNC_TOPIC, () => this.refreshSyncState());
  }

  private salt(): string {
    const salt = process.env.RID_END_USER_HASH_SALT ?? '';
    // Without a salt the hash of an identification number is trivially reversible: fail closed.
    if (salt.length < 16) {
      throw new BundleUnavailableError('RID_END_USER_HASH_SALT is missing or shorter than 16');
    }
    return salt;
  }

  private subjectRefKey(): string {
    const key = process.env.RID_SUBJECT_REF_KEY ?? '';
    // Document numbers are a small space: without a strong key the reference is reversible.
    if (key.length < 32) {
      throw new BundleUnavailableError('RID_SUBJECT_REF_KEY is missing or shorter than 32');
    }
    return key;
  }

  /** RID_GATEWAY_NODES (ADR-0020), 1 by default; a malformed value is not guessed (fail closed). */
  private gatewayNodes(): number {
    const raw = process.env.RID_GATEWAY_NODES ?? '1';
    const nodes = Number(raw);
    if (!Number.isInteger(nodes) || nodes < 1 || nodes > 100) {
      throw new BundleUnavailableError('RID_GATEWAY_NODES must be an integer from 1 to 100');
    }
    return nodes;
  }

  async data(): Promise<{ data: BundleData; subscriptionIds: string[] }> {
    const salt = this.salt();
    const subjectRefKey = this.subjectRefKey();
    const country = getCountryConfig();
    const versions = await this.prisma.apiVersion.findMany({
      where: { status: { in: [...SERVED_VERSIONS] } },
      include: { api: true },
      orderBy: { id: 'asc' },
    });
    const routes: BundleData['routes'] = {};
    const defaultRate = new Map<string, number>();
    for (const v of versions) {
      routes[routeId(v.id)] = {
        apiVersionId: v.id,
        classification: v.api.classification,
        operations: listOperations(v.openapiSpec as Record<string, unknown>).map((o) => {
          const subject = bundleSubject(v.basePath, o.path, o.dataSubject);
          return {
            id: o.operationId,
            method: o.method,
            pathRegex: pathRegex(v.basePath, o.path),
            ...(subject ? { subject } : {}),
          };
        }),
      };
      defaultRate.set(v.id, v.defaultRateLimit);
    }

    const apps = await this.prisma.application.findMany({
      where: { status: { not: 'deleted' } },
      include: {
        entity: true,
        subscriptions: {
          where: {
            status: { in: [...GRANTED] },
            // A provider suspended as such (or offboarded) serves nobody (M2-11).
            apiVersion: {
              status: { in: [...SERVED_VERSIONS] },
              api: { entity: { providerSuspended: false } },
            },
          },
          orderBy: { id: 'asc' },
        },
        // Valid client certificates (M3-02): still usable and not past notAfter.
        credentials: {
          where: {
            kind: 'mtls_certificate',
            status: { in: [...USABLE_CREDENTIAL_STATUSES] },
            notAfter: { gt: new Date() },
            // A previous certificate stops at the end of its rotation window (M3-04).
            OR: [{ status: 'active' }, { rotationEndsAt: { gt: new Date() } }],
          },
          select: { fingerprint: true },
          orderBy: { fingerprint: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });
    const clients: BundleData['clients'] = {};
    const subscriptionIds: string[] = [];
    for (const app of apps) {
      const client: BundleClient = {
        // A suspended or offboarded consumer entity suspends all its applications (M2-11).
        status: app.status === 'active' && app.entity.status === 'active' ? 'active' : 'suspended',
        entityId: app.entityId,
        entitySlug: app.entity.slug,
        applicationId: app.id,
        subscriptions: app.subscriptions.map((s) => {
          subscriptionIds.push(s.id);
          return {
            id: s.id,
            route: routeId(s.apiVersionId),
            operations: s.approvedOperations,
            purposes: [s.purposeCode],
            validFrom: s.validFrom.toISOString(),
            validUntil: s.validUntil.toISOString(),
            endUserRequired: s.endUserIdentificationRequired,
            rateLimitPerMinute: s.rateLimitPerMinute ?? defaultRate.get(s.apiVersionId) ?? 0,
          };
        }),
        certificates: app.credentials.flatMap((c) => (c.fingerprint ? [c.fingerprint] : [])),
      };
      clients[app.keycloakClientId] = client;
    }
    return {
      data: {
        routes,
        clients,
        config: {
          endUserHashSalt: salt,
          subjectRefKey,
          country: country.country.code,
          documentTypes: [...country.identifiers.person],
          mtlsRequired: country.features.mtls.required,
          gatewayNodes: this.gatewayNodes(),
        },
      },
      subscriptionIds,
    };
  }

  /** The current bundle; its revision is recorded so a later status report can be resolved. */
  async bundle(): Promise<BuiltBundle> {
    const { data, subscriptionIds } = await this.data();
    const built = buildBundle(this.policies, data);
    await this.prisma.policyBundle.createMany({
      data: [{ revision: built.revision, subscriptionIds: subscriptionIds.sort() }],
      skipDuplicates: true,
    });
    await this.prisma.policyBundle.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - KEEP_REVISIONS_MS) },
        revision: { not: built.revision },
      },
    });
    return built;
  }

  /** policy.sync: records the revision OPA should converge to (operator console, ADR-0007). */
  async refreshSyncState(): Promise<void> {
    const { revision } = await this.bundle();
    const current = await this.prisma.syncState.findUnique({ where: { target: OPA_SYNC_TARGET } });
    const status = current?.appliedHash === revision ? 'in_sync' : 'pending';
    await this.prisma.syncState.upsert({
      where: { target: OPA_SYNC_TARGET },
      create: { target: OPA_SYNC_TARGET, system: 'opa', desiredHash: revision, status },
      update: { desiredHash: revision, status },
    });
  }

  /**
   * OPA reports the revision it activated. Approved subscriptions in that revision become active,
   * each with an audit event in the same transaction. Unknown revisions are ignored.
   */
  async reportActiveRevision(revision: string): Promise<{ activated: number }> {
    const bundle = await this.prisma.policyBundle.findUnique({ where: { revision } });
    let activated = 0;
    await this.prisma.$transaction(async (tx) => {
      if (bundle && bundle.subscriptionIds.length > 0) {
        const approved = await tx.subscription.findMany({
          where: { id: { in: bundle.subscriptionIds }, status: 'approved' },
          select: { id: true },
        });
        for (const { id } of approved) {
          const changed = await tx.subscription.updateMany({
            where: { id, status: 'approved' },
            data: { status: 'active' },
          });
          if (changed.count === 0) continue;
          activated += 1;
          await this.audit.record(tx, {
            actor: { type: 'system', id: 'opa' },
            action: 'subscription.activated',
            target: { type: 'subscription', id },
            before: { status: 'approved' },
            after: { status: 'active', bundleRevision: revision },
          });
        }
      }
      const current = await tx.syncState.findUnique({ where: { target: OPA_SYNC_TARGET } });
      const desired = current?.desiredHash ?? revision;
      await tx.syncState.upsert({
        where: { target: OPA_SYNC_TARGET },
        create: {
          target: OPA_SYNC_TARGET,
          system: 'opa',
          desiredHash: revision,
          appliedHash: revision,
          status: 'in_sync',
          appliedAt: new Date(),
        },
        update: {
          appliedHash: revision,
          appliedAt: new Date(),
          status: desired === revision ? 'in_sync' : 'pending',
          lastError: null,
        },
      });
    });
    if (activated > 0)
      this.logger.log(`OPA revision ${revision.slice(0, 12)}: ${activated} active`);
    return { activated };
  }
}
