import { timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  CSR_ERRORS,
  type EnrollNodeInput,
  enrollNodeSchema,
  NODE_CONTRACT_VERSION,
  NODE_CSR_COMMON_NAME,
  type NodeConfig,
  type NodeEnrollment,
  type NodeHeartbeatInput,
  nodeDnsName,
  nodeHeartbeatSchema,
  renewNodeCertificateSchema,
} from '@rid/contracts';
import { z } from 'zod';
import { type AuditActor, AuditService } from '../audit/audit.service.js';
import {
  ConflictError,
  ServiceUnavailableError,
  UnauthenticatedError,
  ValidationError,
} from '../common/errors.js';
import { hashSecret } from '../common/secrets.js';
import { leafOf, thumbprintOf } from '../credentials/credential-view.js';
import { checkCsr, CsrRejected } from '../credentials/csr.js';
import { CERTIFICATE_AUTHORITY, type CertificateAuthority } from '../credentials/step-ca.client.js';
import { canTransition, ENROLLED_NODE_STATUSES } from '../domain/node/state-machine.js';
import type { Node as NodeRow } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { hubAddress, nextNodeAddress, tunnelSubnet } from './tunnel.js';

const HOUR = 60 * 60 * 1000;
/** Serializes address allocation across API replicas ("rid_node"). */
const ADDRESS_LOCK = 0x7269645f6e6f6465n;

const positive = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Timing and the hub, from the deployment (ARCHITECTURE.md §10). */
export function nodeControlSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    heartbeatIntervalSeconds: positive(env.RID_NODE_HEARTBEAT_SECONDS, 60),
    /** SPEC.md §4.6: five minutes without a heartbeat is offline. */
    offlineAfterSeconds: positive(env.RID_NODE_OFFLINE_AFTER_SECONDS, 300),
    certificateValidityHours: Math.min(positive(env.RID_NODE_CERT_VALIDITY_HOURS, 2160), 2160),
    /** How long the certificate replaced by a renewal keeps opening the control channel. */
    renewalGraceHours: positive(env.RID_NODE_RENEWAL_GRACE_HOURS, 24),
    controlUrl: (
      env.RID_NODE_CONTROL_URL ??
      env.RID_GATEWAY_PUBLIC_URL ??
      'https://localhost:9443'
    ).replace(/\/+$/, ''),
    hubPublicKey: env.RID_WG_HUB_PUBLIC_KEY || undefined,
    hubEndpoint: env.RID_WG_HUB_ENDPOINT || undefined,
    minimumKitVersion: env.RID_NODE_MIN_KIT_VERSION || null,
    /** Shared with the gateway's control route: proves a request came through APISIX. */
    controlToken: env.RID_NODE_CONTROL_TOKEN || undefined,
  };
}

const SYSTEM: AuditActor = { type: 'system', id: 'system:node-lifecycle' };
const nodeActor = (node: { id: string; entityId: string }): AuditActor => ({
  type: 'system',
  id: nodeDnsName(node.id),
  entityId: node.entityId,
});

/** Compares in constant time; false when either side is missing. */
export function sameSecret(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when a version string is at least `minimum` (major.minor.patch; pre-releases ignored). */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  const [a, b] = [parts(version), parts(minimum)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/**
 * The control channel of kit nodes, portal side (ARCHITECTURE.md §10, M4-02): enrollment with the
 * single-use token, then heartbeats, certificate renewal and configuration over mTLS with the
 * node's certificate (the gateway's control route terminates the TLS and passes the verified
 * thumbprint). Also marks nodes offline after five minutes without a heartbeat.
 */
@Injectable()
export class NodeControlService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NodeControlService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CERTIFICATE_AUTHORITY) private readonly ca: CertificateAuthority,
  ) {}

  onApplicationBootstrap(): void {
    if (!QueueService.enabled()) return;
    const seconds = positive(process.env.RID_NODE_LIFECYCLE_INTERVAL_SECONDS, 60);
    this.timer = setInterval(() => {
      this.markOffline().catch((error: unknown) =>
        this.logger.error(error instanceof Error ? error.message : String(error)),
      );
    }, seconds * 1000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async checkedCsr(csr: string) {
    try {
      return await checkCsr(csr, NODE_CSR_COMMON_NAME, { altNames: 'none' });
    } catch (error) {
      if (error instanceof CsrRejected) {
        throw new ValidationError([{ path: 'csr', message: CSR_ERRORS[error.reason] }]);
      }
      throw error;
    }
  }

  private async sign(nodeId: string, checked: { pem: string; publicKey: Buffer }) {
    const settings = nodeControlSettings();
    const chainPem = await this.ca.sign({
      csrPem: checked.pem,
      commonName: NODE_CSR_COMMON_NAME,
      sans: [nodeDnsName(nodeId)],
      profile: 'node',
      publicKey: checked.publicKey,
      validityHours: settings.certificateValidityHours,
    });
    const leaf = leafOf(chainPem);
    return {
      chainPem,
      fingerprint: thumbprintOf(leaf),
      serial: leaf.serialNumber.toLowerCase(),
      notAfter: leaf.validToDate,
    };
  }

  /**
   * Enrollment (SPEC.md §4.6 step 2). The token is checked first, then the CSR and the hub; the
   * CA signs before the transaction, which marks the token used only if nobody did meanwhile. A
   * failure before the commit leaves the token usable. Every refusal of the token is the same
   * 401, so the endpoint does not tell an expired token from one that never existed.
   */
  async enroll(input: EnrollNodeInput, requestId?: string): Promise<NodeEnrollment> {
    const data = enrollNodeSchema.parse(input);
    const settings = nodeControlSettings();
    const token = await this.prisma.nodeEnrollmentToken.findUnique({
      where: { tokenHash: hashSecret(data.token) },
      include: { node: { include: { entity: { select: { status: true } } } } },
    });
    const now = new Date();
    if (
      !token ||
      token.status !== 'active' ||
      token.expiresAt <= now ||
      token.node.status !== 'enrollment_issued' ||
      token.node.entity.status !== 'active'
    ) {
      throw new InvalidEnrollmentTokenError();
    }
    const node = token.node;
    const checked = await this.checkedCsr(data.csr);
    if (!settings.hubPublicKey || !settings.hubEndpoint) {
      this.logger.error('RID_WG_HUB_PUBLIC_KEY or RID_WG_HUB_ENDPOINT is not set');
      throw new ServiceUnavailableError('The tunnel hub is not configured');
    }
    const issued = await this.sign(node.id, checked);
    const subnet = tunnelSubnet();

    let address: string;
    try {
      address = await this.prisma.$transaction(async (tx) => {
        const used = await tx.nodeEnrollmentToken.updateMany({
          where: { id: token.id, status: 'active', expiresAt: { gt: now } },
          data: { status: 'used', usedAt: now },
        });
        if (used.count === 0) throw new InvalidEnrollmentTokenError();
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADDRESS_LOCK})`;
        const taken = await tx.node.findMany({
          where: { tunnelAddress: { not: null } },
          select: { tunnelAddress: true },
        });
        const next = nextNodeAddress(
          subnet,
          taken.map((n) => n.tunnelAddress ?? ''),
        );
        const changed = await tx.node.updateMany({
          where: { id: node.id, status: 'enrollment_issued' },
          data: {
            status: 'enrolled',
            tunnelAddress: next,
            wireguardPublicKey: data.wireguardPublicKey,
            certificatePem: issued.chainPem,
            certificateSerial: issued.serial,
            certificateFingerprint: issued.fingerprint,
            certificateNotAfter: issued.notAfter,
            kitVersion: data.kitVersion,
            servicePort: data.servicePort,
            enrolledAt: now,
          },
        });
        if (changed.count === 0) throw new InvalidEnrollmentTokenError();
        await this.audit.record(tx, {
          actor: nodeActor(node),
          action: 'node.enrolled',
          target: { type: 'node', id: node.id },
          before: { status: 'enrollment_issued' },
          // Public facts only: the certificate's thumbprint and serial, never a key.
          after: {
            status: 'enrolled',
            tokenId: token.id,
            tunnelAddress: next,
            wireguardPublicKey: data.wireguardPublicKey,
            certificateFingerprint: issued.fingerprint,
            certificateSerial: issued.serial,
            certificateNotAfter: issued.notAfter.toISOString(),
            kitVersion: data.kitVersion,
          },
          requestId,
        });
        return next;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The WireGuard key (or, in theory, the certificate) belongs to another node.
        throw new ConflictError('That WireGuard public key is already enrolled in the network');
      }
      throw error;
    }

    return {
      contractVersion: NODE_CONTRACT_VERSION,
      nodeId: node.id,
      nodeName: nodeDnsName(node.id),
      certificate: issued.chainPem,
      certificateNotAfter: issued.notAfter.toISOString(),
      caCertificate: await this.ca.rootCertificate(),
      controlUrl: settings.controlUrl,
      heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
      wireguard: {
        address: `${address}/32`,
        hubPublicKey: settings.hubPublicKey,
        hubEndpoint: settings.hubEndpoint,
        hubAddress: hubAddress(subnet),
        allowedIps: [`${hubAddress(subnet)}/32`],
        persistentKeepaliveSeconds: 25,
      },
    };
  }

  /**
   * The node behind a request on the control channel: the thumbprint the gateway verified must be
   * the node's current certificate, or the one its last renewal replaced while that grace lasts.
   * Anything else (unknown, decommissioned, another node's id) is null.
   */
  async authenticate(
    nodeId: string,
    fingerprint: string,
    now = new Date(),
  ): Promise<NodeRow | null> {
    const node = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!node || !(ENROLLED_NODE_STATUSES as readonly string[]).includes(node.status)) return null;
    const current =
      node.certificateFingerprint === fingerprint &&
      node.certificateNotAfter !== null &&
      node.certificateNotAfter > now;
    const previous =
      node.previousCertificateFingerprint === fingerprint &&
      node.previousCertificateUntil !== null &&
      node.previousCertificateUntil > now;
    return current || previous ? node : null;
  }

  /** Heartbeat (SPEC.md §4.6 step 3): an enrolled or offline node comes online. */
  async heartbeat(node: NodeRow, input: NodeHeartbeatInput) {
    const data = nodeHeartbeatSchema.parse(input);
    const settings = nodeControlSettings();
    const now = new Date();
    const servicesChanged = JSON.stringify(node.services ?? []) !== JSON.stringify(data.services);
    const comesOnline = node.status !== 'online' && canTransition(node.status, 'online');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.node.updateMany({
        where: { id: node.id, status: { in: [...ENROLLED_NODE_STATUSES] } },
        data: {
          lastHeartbeatAt: now,
          kitVersion: data.kitVersion,
          servicePort: data.servicePort,
          services: data.services,
          health: { ...data.health, checkedAt: now.toISOString() },
          ...(comesOnline ? { status: 'online' } : {}),
        },
      });
      if (changed.count === 0) throw new ConflictError('The node is not enrolled');
      if (comesOnline) {
        await this.audit.record(tx, {
          actor: nodeActor(node),
          action: 'node.online',
          target: { type: 'node', id: node.id },
          before: { status: node.status },
          after: { status: 'online', kitVersion: data.kitVersion },
        });
      }
      if (servicesChanged) {
        await this.audit.record(tx, {
          actor: nodeActor(node),
          action: 'node.services_changed',
          target: { type: 'node', id: node.id },
          before: { services: node.services },
          after: { services: data.services, servicePort: data.servicePort },
        });
      }
    });
    return {
      status: comesOnline ? ('online' as const) : node.status,
      nextHeartbeatSeconds: settings.heartbeatIntervalSeconds,
      renewCertificate: renewalDue(node.certificatePem, now),
    };
  }

  /** Renewal: a new certificate for a new key; the replaced one keeps working for the grace. */
  async renew(node: NodeRow, csr: string, requestId?: string) {
    const { csr: pem } = renewNodeCertificateSchema.parse({ csr });
    const settings = nodeControlSettings();
    const checked = await this.checkedCsr(pem);
    const issued = await this.sign(node.id, checked);
    const graceUntil = new Date(Date.now() + settings.renewalGraceHours * HOUR);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.node.updateMany({
        where: {
          id: node.id,
          status: { in: [...ENROLLED_NODE_STATUSES] },
          certificateFingerprint: node.certificateFingerprint,
        },
        data: {
          previousCertificateFingerprint: node.certificateFingerprint,
          previousCertificateUntil:
            node.certificateNotAfter && node.certificateNotAfter < graceUntil
              ? node.certificateNotAfter
              : graceUntil,
          certificatePem: issued.chainPem,
          certificateSerial: issued.serial,
          certificateFingerprint: issued.fingerprint,
          certificateNotAfter: issued.notAfter,
        },
      });
      if (changed.count === 0) {
        throw new ConflictError('The certificate of the node changed meanwhile');
      }
      await this.audit.record(tx, {
        actor: nodeActor(node),
        action: 'node.certificate_renewed',
        target: { type: 'node', id: node.id },
        before: { certificateFingerprint: node.certificateFingerprint },
        after: {
          certificateFingerprint: issued.fingerprint,
          certificateSerial: issued.serial,
          certificateNotAfter: issued.notAfter.toISOString(),
        },
        requestId,
      });
    });
    return {
      certificate: issued.chainPem,
      certificateNotAfter: issued.notAfter.toISOString(),
      previousValidUntil: graceUntil.toISOString(),
    };
  }

  /** What the network expects from the node: published versions it serves, minimum kit. */
  async config(node: NodeRow): Promise<NodeConfig> {
    const settings = nodeControlSettings();
    const versions = await this.prisma.apiVersion.findMany({
      where: {
        upstreamType: 'node',
        status: { in: ['published', 'deprecated'] },
        upstream: { path: ['nodeId'], equals: node.id },
      },
      include: { api: { select: { name: true, entityId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const notices: NodeConfig['notices'] = [];
    if (
      settings.minimumKitVersion &&
      node.kitVersion &&
      !versionAtLeast(node.kitVersion, settings.minimumKitVersion)
    ) {
      notices.push({
        code: 'kit_outdated',
        message: `Kit ${node.kitVersion} is older than the minimum ${settings.minimumKitVersion}`,
      });
    }
    return {
      contractVersion: NODE_CONTRACT_VERSION,
      nodeId: node.id,
      heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
      minimumKitVersion: settings.minimumKitVersion,
      services: versions
        // A version of another entity naming this node is never served by it (M4-04).
        .filter((v) => v.api.entityId === node.entityId)
        .map((v) => ({
          apiVersionId: v.id,
          apiName: v.api.name,
          version: v.version,
          basePath: v.basePath,
          servicePath: z.object({ servicePath: z.string() }).parse(v.upstream).servicePath,
        })),
      notices,
    };
  }

  /**
   * Five minutes without a heartbeat (SPEC.md §4.6 step 3): online and enrolled nodes go offline.
   * The audited `node.offline` alerts the entity's admins and the operator (M2-08). Idempotent.
   */
  async markOffline(now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - nodeControlSettings().offlineAfterSeconds * 1000);
    const due = await this.prisma.node.findMany({
      where: {
        OR: [
          { status: 'online', lastHeartbeatAt: { lt: cutoff } },
          { status: 'enrolled', enrolledAt: { lt: cutoff }, lastHeartbeatAt: null },
        ],
      },
      select: { id: true, entityId: true, status: true, lastHeartbeatAt: true },
      take: 500,
    });
    const marked: string[] = [];
    for (const node of due) {
      const done = await this.prisma.$transaction(async (tx: Tx) => {
        const changed = await tx.node.updateMany({
          where: { id: node.id, status: node.status, lastHeartbeatAt: node.lastHeartbeatAt },
          data: { status: 'offline' },
        });
        if (changed.count === 0) return false;
        await this.audit.record(tx, {
          actor: { ...SYSTEM, entityId: node.entityId },
          action: 'node.offline',
          target: { type: 'node', id: node.id },
          before: { status: node.status },
          after: {
            status: 'offline',
            lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
          },
        });
        return true;
      });
      if (done) marked.push(node.id);
    }
    return marked;
  }
}

/** Every refusal of an enrollment token: 401, without telling why. */
export class InvalidEnrollmentTokenError extends UnauthenticatedError {
  constructor() {
    super('The enrollment token is not valid');
  }
}

/** Renew in the last third of the certificate's life, like the gateway's own certificates. */
export function renewalDue(certificatePem: string | null, now = new Date()): boolean {
  if (!certificatePem) return false;
  const leaf = leafOf(certificatePem);
  const from = new Date(leaf.validFrom).getTime();
  const to = new Date(leaf.validTo).getTime();
  return to - now.getTime() < (to - from) / 3;
}
