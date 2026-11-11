import { Inject, Injectable } from '@nestjs/common';
import type { EntityRole, PlatformRole } from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import { ConflictError, ForbiddenError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TOKEN_VERIFIER, type TokenVerifier, type VerifiedIdentity } from './token-verifier.js';

export interface PrincipalMembership {
  entityId: string;
  entitySlug: string;
  entityShortName: string;
  roles: EntityRole[];
}

/** The authenticated caller with roles loaded from PostgreSQL on this very request (ADR-0004). */
export interface Principal {
  userId: string;
  keycloakSub: string;
  email: string;
  fullName: string;
  platformRoles: PlatformRole[];
  /** Active memberships only: a revoked membership loses access on the next request. */
  memberships: PrincipalMembership[];
}

@Injectable()
export class PrincipalService {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  verifyToken(token: string): Promise<VerifiedIdentity> {
    return this.verifier.verify(token);
  }

  /** Loads (or registers on first login) the user behind a verified identity. */
  async load(identity: VerifiedIdentity, requestId?: string): Promise<Principal> {
    const include = {
      platformRoles: true,
      memberships: { where: { status: 'active' as const }, include: { entity: true } },
    };
    const find = () =>
      this.prisma.user.findUnique({ where: { keycloakSub: identity.sub }, include });
    let user = await find();
    if (!user) {
      await this.register(identity, requestId);
      user = await find();
    }
    if (!user) throw new ForbiddenError('The user could not be registered');
    if (user.status !== 'active') throw new ForbiddenError('The user account is disabled');

    return {
      userId: user.id,
      keycloakSub: user.keycloakSub,
      email: user.email,
      fullName: user.fullName,
      platformRoles: user.platformRoles.map((r) => r.role),
      memberships: user.memberships.map((m) => ({
        entityId: m.entityId,
        entitySlug: m.entity.slug,
        entityShortName: m.entity.shortName,
        roles: m.roles,
      })),
    };
  }

  /**
   * First login of someone Keycloak already authenticated: create the user without any role.
   * Roles only come from invitations and explicit grants, all audited.
   */
  private async register(identity: VerifiedIdentity, requestId: string | undefined): Promise<void> {
    if (!identity.email) throw new ForbiddenError('The identity provider did not send an e-mail');
    const email = identity.email;
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictError('Another account already uses this e-mail');
    }
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          keycloakSub: identity.sub,
          email,
          fullName: identity.name ?? email,
          status: 'active',
          createdBy: identity.sub,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: identity.sub },
        action: 'user.registered',
        target: { type: 'user', id: created.id },
        after: created,
        requestId,
      });
    });
  }
}
