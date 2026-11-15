import { Injectable } from '@nestjs/common';
import type {
  ApplicationDetail,
  ApplicationSummary,
  CreatedApplication,
  CreateApplicationInput,
  PaginationQuery,
  Provisioning,
} from '@rid/contracts';
import { createApplicationSchema } from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { NotFoundError } from '../common/errors.js';
import { generateClientSecret, hashSecret, seal } from '../common/secrets.js';
import { uuidv7 } from '../common/uuidv7.js';
import { credentialView } from '../credentials/credential-view.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';
import { KEYCLOAK_SYNC_TOPIC, syncTarget } from '../reconcilers/keycloak/keycloak.reconciler.js';

type AppRow = Prisma.ApplicationGetPayload<{ include: { credentials: true } }>;

/** Token endpoint consumers use (client_credentials) in the realm rid-gateway. */
export const gatewayTokenUrl = (): string =>
  `${process.env.KEYCLOAK_URL ?? 'http://localhost:8080'}/realms/rid-gateway/protocol/openid-connect/token`;

/**
 * Consumer applications and their OAuth2 credentials (SPEC.md §4.3, M1-06). The Keycloak client is
 * created by the reconciler from the outbox; this service never calls Keycloak (CLAUDE.md).
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async provisioning(apps: AppRow[]): Promise<Map<string, Provisioning>> {
    const states = await this.prisma.syncState.findMany({
      where: { target: { in: apps.map((a) => syncTarget(a.keycloakClientId)) } },
    });
    const byTarget = new Map(states.map((s) => [s.target, s.status]));
    return new Map(
      apps.map((a) => {
        const status = byTarget.get(syncTarget(a.keycloakClientId));
        const secretPending = a.credentials.some((c) => c.sealedSecret);
        const value: Provisioning =
          status === 'error'
            ? 'error'
            : status === 'in_sync' && !secretPending
              ? 'ready'
              : 'pending';
        return [a.id, value];
      }),
    );
  }

  private summary(app: AppRow, provisioning: Provisioning): ApplicationSummary {
    return {
      id: app.id,
      name: app.name,
      environment: app.environment,
      status: app.status,
      clientId: app.keycloakClientId,
      provisioning,
      createdAt: app.createdAt.toISOString(),
    };
  }

  private detail(app: AppRow, provisioning: Provisioning): ApplicationDetail {
    return {
      ...this.summary(app, provisioning),
      description: app.description,
      technicalContact: app.technicalContact,
      tokenUrl: gatewayTokenUrl(),
      // Metadata only: no secret, hash or sealed value leaves the API.
      credentials: app.credentials
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((c) => credentialView(c)),
    };
  }

  async list(entityId: string, page: PaginationQuery) {
    const rows = (await scopedRepo(this.prisma.application, entityId).findMany({
      where: { status: { not: 'deleted' } },
      orderBy: { id: 'asc' },
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    })) as Array<Omit<AppRow, 'credentials'>>;
    const items = rows.slice(0, page.limit);
    const credentials = await this.prisma.credential.findMany({
      where: { applicationId: { in: items.map((a) => a.id) } },
    });
    const withCredentials: AppRow[] = items.map((a) => ({
      ...a,
      credentials: credentials.filter((c) => c.applicationId === a.id),
    }));
    const provisioning = await this.provisioning(withCredentials);
    return {
      items: withCredentials.map((a) => this.summary(a, provisioning.get(a.id) ?? 'pending')),
      nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async get(entityId: string, applicationId: string): Promise<ApplicationDetail> {
    const app = await scopedRepo(this.prisma.application, entityId).findFirst({
      where: { id: applicationId },
    });
    if (!app) throw new NotFoundError('Application');
    const full = await this.prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: { credentials: true },
    });
    const provisioning = await this.provisioning([full]);
    return this.detail(full, provisioning.get(full.id) ?? 'pending');
  }

  async create(
    entityId: string,
    principal: Principal,
    input: CreateApplicationInput,
    requestId?: string,
  ): Promise<CreatedApplication> {
    const data = createApplicationSchema.parse(input);
    const applicationId = uuidv7();
    const credentialId = uuidv7();
    // Generated here, returned once in this response, never stored in clear.
    const clientSecret = generateClientSecret();
    const actor = { type: 'user' as const, id: principal.keycloakSub, entityId };

    await this.prisma.$transaction(async (tx) => {
      const app = await tx.application.create({
        data: {
          id: applicationId,
          entityId,
          ...data,
          keycloakClientId: `rid-app-${applicationId}`,
          status: 'active',
          createdBy: principal.userId,
        },
      });
      const credential = await tx.credential.create({
        data: {
          id: credentialId,
          applicationId,
          kind: 'client_secret',
          status: 'active',
          secretHash: hashSecret(clientSecret),
          sealedSecret: seal(clientSecret, credentialId),
          createdBy: principal.userId,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'application.created',
        target: { type: 'application', id: app.id },
        after: app,
        requestId,
      });
      await this.audit.record(tx, {
        actor,
        action: 'credential.created',
        target: { type: 'credential', id: credential.id },
        // Domain fields only: neither the secret, its hash nor the sealed copy.
        after: {
          id: credential.id,
          applicationId,
          kind: credential.kind,
          status: credential.status,
        },
        requestId,
      });
      await this.outbox.enqueue(tx, {
        topic: KEYCLOAK_SYNC_TOPIC,
        aggregate: `application:${applicationId}`,
        payload: { reason: 'created' },
      });
    });

    return { application: await this.get(entityId, applicationId), clientSecret };
  }
}
