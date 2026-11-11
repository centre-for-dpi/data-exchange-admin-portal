import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ForbiddenError, NotFoundError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type AuthenticatedRequest,
  ENTITY_ACTION,
  type EntityContext,
  IS_PUBLIC,
} from './decorators.js';
import { ENTITY_PERMISSIONS, type EntityAction } from './policy.js';
import { type Principal, PrincipalService } from './principal.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global guard (CLAUDE.md, rule 3): authenticates every non-public endpoint and enforces entity
 * scoping. Order of checks for @EntityAccess endpoints:
 *   1. not a member and no allowed platform role -> 404 (do not reveal that the entity exists);
 *   2. member without an allowed role -> 403;
 *   3. allowed platform role but the entity does not exist -> 404.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & AuthenticatedRequest>();
    const principal = await this.authenticate(request);
    request.principal = principal;

    const action = this.reflector.getAllAndOverride<EntityAction | undefined>(
      ENTITY_ACTION,
      targets,
    );
    if (action) {
      const entityId = (request.params as Record<string, string | undefined>).entityId;
      request.entityContext = await this.authorizeEntity(principal, action, entityId);
    }
    return true;
  }

  private async authenticate(request: FastifyRequest): Promise<Principal> {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match?.[1]) throw new UnauthorizedException('Missing bearer token');
    let identity;
    try {
      identity = await this.principals.verifyToken(match[1]);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return this.principals.load(identity, request.id);
  }

  private async authorizeEntity(
    principal: Principal,
    action: EntityAction,
    entityId: string | undefined,
  ): Promise<EntityContext> {
    if (!entityId || !UUID.test(entityId)) throw new NotFoundError('Entity');
    const permission = ENTITY_PERMISSIONS[action];

    const membership = principal.memberships.find((m) => m.entityId === entityId);
    const platformAllowed = principal.platformRoles.some((role) =>
      (permission.platformRoles as readonly string[]).includes(role),
    );

    if (membership) {
      if (
        membership.roles.some((role) =>
          (permission.entityRoles as readonly string[]).includes(role),
        )
      ) {
        return { entityId, roles: membership.roles, via: 'membership' };
      }
      if (!platformAllowed) throw new ForbiddenError();
    } else if (!platformAllowed) {
      throw new NotFoundError('Entity');
    }

    const exists = await this.prisma.entity.findUnique({
      where: { id: entityId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError('Entity');
    return { entityId, roles: membership?.roles ?? [], via: 'platform' };
  }
}
