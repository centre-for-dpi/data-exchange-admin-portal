import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { hashSecret, open } from '../../common/secrets.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { type GatewayClient, KEYCLOAK_ADMIN, type KeycloakGatewayAdmin } from './keycloak-admin.js';

/** Outbox topic for changes that affect Keycloak clients of the rid-gateway realm. */
export const KEYCLOAK_SYNC_TOPIC = 'keycloak.sync';
const FULL_RECONCILE_MS = 5 * 60 * 1000;

export type ReconcileResult = 'created' | 'updated' | 'unchanged' | 'missing';

export const syncTarget = (clientId: string): string => `keycloak:client:${clientId}`;

const COMPARED: Array<keyof GatewayClient> = [
  'name',
  'description',
  'enabled',
  'publicClient',
  'serviceAccountsEnabled',
  'standardFlowEnabled',
  'directAccessGrantsEnabled',
  'implicitFlowEnabled',
  'attributes',
];

/**
 * Makes each consumer application exist as a confidential client in rid-gateway
 * (ARCHITECTURE.md §3.2, §4.3). Desired state comes from PostgreSQL only; the reconciler reads
 * Keycloak, applies the difference with idempotent calls and records the outcome in sync_state.
 * Runs from the outbox (keycloak.sync) and as a full pass every 5 minutes to repair drift.
 */
@Injectable()
export class KeycloakReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KeycloakReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(KEYCLOAK_ADMIN) private readonly admin: KeycloakGatewayAdmin,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(KEYCLOAK_SYNC_TOPIC, (data) => this.handle(data));
    // Converge right after a restart instead of waiting for the first periodic pass.
    void this.reconcileAll();
    this.timer = setInterval(() => void this.reconcileAll(), FULL_RECONCILE_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async handle(data: Record<string, unknown>): Promise<void> {
    const [kind, id] = (typeof data.aggregate === 'string' ? data.aggregate : '').split(':');
    if (kind === 'application' && id) await this.reconcileApplication(id);
  }

  /** Full pass over every application (drift repair). Errors are recorded per application. */
  async reconcileAll(): Promise<void> {
    const apps = await this.prisma.application.findMany({ select: { id: true } });
    for (const app of apps) {
      try {
        await this.reconcileApplication(app.id);
      } catch (error) {
        this.logger.warn(`Keycloak reconcile of application ${app.id} failed: ${String(error)}`);
      }
    }
  }

  async reconcileApplication(applicationId: string): Promise<ReconcileResult> {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        credentials: {
          where: { kind: 'client_secret', status: { in: ['active', 'rotating'] } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!app) return 'missing';

    const active = app.credentials.find((c) => c.status === 'active');
    // The previous secret during its rotation window (M3-04).
    const rotating = app.credentials.find(
      (c) => c.status === 'rotating' && c.rotationEndsAt && c.rotationEndsAt > new Date(),
    );
    const pending = active?.sealedSecret ? active : undefined;
    const desired: GatewayClient = {
      clientId: app.keycloakClientId,
      name: app.name,
      description: app.description.slice(0, 255),
      // Suspended or deleted applications keep their client, disabled: tokens stop being issued.
      enabled: app.status === 'active',
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      implicitFlowEnabled: false,
      attributes: {
        'rid.application': app.id,
        'rid.entity': app.entityId,
        'rid.environment': app.environment,
        // Puts the client under the realm's secret rotation policy (M3-04).
        'rid.managed': 'true',
      },
    };
    const desiredHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...desired,
          secret: active?.secretHash ?? null,
          rotated: rotating?.secretHash ?? null,
        }),
      )
      .digest('hex');
    const target = syncTarget(app.keycloakClientId);

    try {
      const secret = pending?.sealedSecret ? open(pending.sealedSecret, pending.id) : undefined;
      const actual = await this.admin.findClient(app.keycloakClientId);
      let result: ReconcileResult;
      if (!actual) {
        if (!secret) {
          throw new Error(
            'Client missing in Keycloak and its secret is no longer available: rotate the credential',
          );
        }
        await this.admin.createClient({ ...desired, secret });
        result = 'created';
      } else {
        const id = actual.id ?? '';
        let changed = COMPARED.some((f) => !isDeepStrictEqual(desired[f], actual[f]));
        if (changed) {
          // Attributes first: the rotation policy applies to clients with rid.managed.
          await this.admin.updateClient(id, desired);
        }
        if (secret) {
          const current = await this.admin.currentSecret(id);
          if (!current || hashSecret(current) !== pending?.secretHash) {
            // A rotation: Keycloak keeps the previous secret as the rotated one (regenerate),
            // then takes the new secret as the current one. If the previous secret is no longer
            // the current one (an interrupted pass), it is already the rotated one.
            if (rotating && current && hashSecret(current) === rotating.secretHash) {
              await this.admin.regenerateSecret(id);
            }
            await this.admin.updateClient(id, { ...desired, secret });
            changed = true;
          }
        }
        // Without a rotation in progress (revoked, or its window ended) no rotated secret stays.
        if (!rotating && (await this.admin.rotatedSecret(id)) !== undefined) {
          await this.admin.deleteRotatedSecret(id);
          changed = true;
        }
        result = changed ? 'updated' : 'unchanged';
      }

      // Keycloak has the secret now: the sealed copy is erased (never kept longer than needed).
      if (pending?.sealedSecret) {
        await this.prisma.credential.updateMany({
          where: { id: pending.id, sealedSecret: pending.sealedSecret },
          data: { sealedSecret: null },
        });
      }
      await this.prisma.syncState.upsert({
        where: { target },
        create: {
          target,
          system: 'keycloak',
          desiredHash,
          appliedHash: desiredHash,
          status: 'in_sync',
          appliedAt: new Date(),
        },
        update: {
          desiredHash,
          appliedHash: desiredHash,
          status: 'in_sync',
          appliedAt: new Date(),
          lastError: null,
          attempts: 0,
        },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.syncState.upsert({
        where: { target },
        create: {
          target,
          system: 'keycloak',
          desiredHash,
          status: 'error',
          lastError: message,
          attempts: 1,
        },
        update: { desiredHash, status: 'error', lastError: message, attempts: { increment: 1 } },
      });
      throw error;
    }
  }
}
