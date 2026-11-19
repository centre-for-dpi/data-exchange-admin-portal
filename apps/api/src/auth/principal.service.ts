import { Inject, Injectable } from '@nestjs/common';
import type { EntityRole, PlatformRole } from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import { ConflictError, ForbiddenError } from '../common/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requiresMfa } from './authz.policy.js';
import { bootstrapPlatformAdmin } from './bootstrap-admin.js';
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
  /**
   * The token proves this very e-mail is verified (email_verified and the same address the user
   * registered with). Invitations are only accepted with a verified e-mail (ADR-0018).
   */
  emailVerified: boolean;
  fullName: string;
  platformRoles: PlatformRole[];
  /** Active memberships only: a revoked membership loses access on the next request. */
  memberships: PrincipalMembership[];
  /** The roles of this request need a second factor (requiresMfa, M3-08). */
  mfaRequired: boolean;
  /** This session was opened with the second factor (token acr). */
  mfa: boolean;
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
      try {
        await this.register(identity, requestId);
      } catch (error) {
        // Two first requests of the same person at once (the web fires several on sign-in): the
        // other one registered them between our read and our insert. Whoever lost reads the
        // user the winner created (B-21); a different account with the same e-mail stays a 409.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
        if (!(await find())) throw new ConflictError('Another account already uses this e-mail');
      }
      user = await find();
    }
    if (!user) throw new ForbiddenError('The user could not be registered');
    if (user.status !== 'active') throw new ForbiddenError('The user account is disabled');

    const platformRoles = user.platformRoles.map((r) => r.role);
    const memberships = user.memberships.map((m) => ({
      entityId: m.entityId,
      entitySlug: m.entity.slug,
      entityShortName: m.entity.shortName,
      roles: m.roles,
    }));
    return {
      userId: user.id,
      keycloakSub: user.keycloakSub,
      email: user.email,
      emailVerified:
        identity.emailVerified && identity.email?.toLowerCase() === user.email.toLowerCase(),
      fullName: user.fullName,
      platformRoles,
      memberships,
      mfaRequired: requiresMfa(platformRoles, memberships),
      mfa: identity.mfa,
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
      // The first platform administrator of a production network (M6-05), in the same transaction.
      await bootstrapPlatformAdmin(
        tx,
        this.audit,
        { userId: created.id, email, emailVerified: identity.emailVerified },
        process.env.DEN_BOOTSTRAP_ADMIN_EMAIL,
        requestId,
      );
    });
  }
}
