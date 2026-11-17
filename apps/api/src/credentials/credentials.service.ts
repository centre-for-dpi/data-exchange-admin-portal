import { Injectable } from '@nestjs/common';
import { getCountryConfig } from '@den/config';
import {
  type CredentialView,
  type RevokeCredentialInput,
  revokeCredentialSchema,
  type RotatedSecret,
} from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { generateClientSecret, hashSecret, seal } from '../common/secrets.js';
import { uuidv7 } from '../common/uuidv7.js';
import { assertTransition } from '../domain/credential/state-machine.js';
import type { Credential, Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';
import { KEYCLOAK_SYNC_TOPIC } from '../reconcilers/keycloak/keycloak.reconciler.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';
import { credentialView } from './credential-view.js';

const DAY = 24 * 60 * 60 * 1000;

/** What a credential change must reach: Keycloak for secrets, the OPA bundle for certificates. */
export async function queueCredentialSync(
  outbox: OutboxService,
  tx: Prisma.TransactionClient,
  credential: Pick<Credential, 'id' | 'kind' | 'applicationId'>,
  reason: string,
): Promise<void> {
  await outbox.enqueue(
    tx,
    credential.kind === 'client_secret'
      ? {
          topic: KEYCLOAK_SYNC_TOPIC,
          aggregate: `application:${credential.applicationId}`,
          payload: { reason },
        }
      : { topic: POLICY_SYNC_TOPIC, aggregate: `credential:${credential.id}`, payload: { reason } },
  );
}

/**
 * Rotation and revocation of application credentials (SPEC.md §4.3, M3-04).
 *
 * - Rotating the secret issues a new one (shown once) and keeps the previous one working for
 *   lifecycle.credentialRotationDays, so the consumer can deploy the new secret without downtime.
 *   Keycloak holds both: the reconciler moves the previous secret to the client's rotated secret.
 * - A certificate rotates by issuing a new one while the current one is active (CertificatesService).
 * - Revoking stops a credential at once. The current secret cannot be revoked (an application
 *   always has one): rotate it, then revoke the previous one.
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async application(entityId: string, applicationId: string) {
    const app = await scopedRepo(this.prisma.application, entityId).findFirst({
      where: { id: applicationId, status: { not: 'deleted' } },
    });
    if (!app) throw new NotFoundError('Application');
    return app;
  }

  async rotateSecret(
    entityId: string,
    principal: Principal,
    applicationId: string,
    requestId?: string,
  ): Promise<RotatedSecret> {
    const app = await this.application(entityId, applicationId);
    if (app.status !== 'active') {
      throw new ConflictError('Only an active application can rotate its secret');
    }
    const secrets = await this.prisma.credential.findMany({
      where: { applicationId, kind: 'client_secret', status: { in: ['active', 'rotating'] } },
    });
    if (secrets.some((c) => c.status === 'rotating')) {
      throw new ConflictError(
        'A secret rotation is already in progress: let it end or revoke the previous secret',
      );
    }
    const previous = secrets.find((c) => c.status === 'active');
    if (!previous) throw new ConflictError('The application has no current secret to rotate');

    const clientSecret = generateClientSecret();
    const credentialId = uuidv7();
    const rotationEndsAt = new Date(
      Date.now() + getCountryConfig().lifecycle.credentialRotationDays * DAY,
    );
    const actor = { type: 'user' as const, id: principal.keycloakSub, entityId };

    const { created, rotating } = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.credential.updateMany({
        where: { id: previous.id, status: 'active' },
        data: { status: 'rotating', rotationEndsAt },
      });
      if (changed.count === 0) throw new ConflictError('The secret changed meanwhile: try again');
      const created = await tx.credential.create({
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
        action: 'credential.rotation_started',
        target: { type: 'credential', id: previous.id },
        before: { status: 'active' },
        after: { status: 'rotating', rotationEndsAt: rotationEndsAt.toISOString() },
        requestId,
      });
      await this.audit.record(tx, {
        actor,
        action: 'credential.created',
        target: { type: 'credential', id: created.id },
        // Domain fields only: neither the secret, its hash nor the sealed copy.
        after: {
          id: created.id,
          applicationId,
          kind: created.kind,
          status: created.status,
          replaces: previous.id,
        },
        requestId,
      });
      await queueCredentialSync(this.outbox, tx, created, 'secret_rotated');
      const rotating = await tx.credential.findUniqueOrThrow({ where: { id: previous.id } });
      return { created, rotating };
    });
    return {
      credential: credentialView(created),
      previous: credentialView(rotating),
      clientSecret,
    };
  }

  async revoke(
    entityId: string,
    principal: Principal,
    applicationId: string,
    credentialId: string,
    input: RevokeCredentialInput,
    requestId?: string,
  ): Promise<CredentialView> {
    const { reason } = revokeCredentialSchema.parse(input);
    await this.application(entityId, applicationId);
    const credential = await this.prisma.credential.findFirst({
      where: { id: credentialId, applicationId },
    });
    if (!credential) throw new NotFoundError('Credential');
    if (credential.kind === 'client_secret' && credential.status === 'active') {
      throw new ConflictError(
        'The current secret cannot be revoked: rotate it, then revoke the previous one',
      );
    }
    assertTransition(credential.status, 'revoked');

    const revoked = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.credential.updateMany({
        where: { id: credential.id, status: credential.status },
        data: { status: 'revoked', rotationEndsAt: null },
      });
      if (changed.count === 0) {
        throw new ConflictError('The credential changed meanwhile: reload and try again');
      }
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub, entityId },
        action: 'credential.revoked',
        target: { type: 'credential', id: credential.id },
        before: { status: credential.status },
        after: {
          status: 'revoked',
          kind: credential.kind,
          ...(credential.fingerprint ? { fingerprint: credential.fingerprint } : {}),
          ...(reason ? { reason } : {}),
        },
        requestId,
      });
      await queueCredentialSync(this.outbox, tx, credential, 'credential_revoked');
      return tx.credential.findUniqueOrThrow({ where: { id: credential.id } });
    });
    return credentialView(revoked);
  }
}
