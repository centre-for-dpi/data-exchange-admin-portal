import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { EntityRole } from '@rid/contracts';
import type { EntityAction, PlatformAction } from './policy.js';
import type { Principal } from './principal.service.js';

export const IS_PUBLIC = 'rid:public';
export const ENTITY_ACTION = 'rid:entity-action';
export const PLATFORM_ACTION = 'rid:platform-action';

/** Endpoint that does not require authentication (health checks). Everything else does. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Endpoint on a resource owned by the entity in the `:entityId` route param. The guard returns
 * 404 to callers outside that entity (and without a platform role allowed for the action), and
 * 403 to members whose roles do not allow it (CLAUDE.md, definition of done).
 */
export const EntityAccess = (action: EntityAction) => SetMetadata(ENTITY_ACTION, action);

/** Endpoint on a platform-wide resource: callers without an allowed platform role get 403. */
export const PlatformAccess = (action: PlatformAction) => SetMetadata(PLATFORM_ACTION, action);

/** How the caller reached the entity of this request, set by the guard. */
export interface EntityContext {
  entityId: string;
  /** Roles of the caller's active membership in this entity (empty for platform access). */
  roles: EntityRole[];
  via: 'membership' | 'platform';
}

export interface AuthenticatedRequest {
  principal?: Principal;
  entityContext?: EntityContext;
  id?: string;
}

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a public endpoint');
  return principal;
});

export const CurrentEntity = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const entity = ctx.switchToHttp().getRequest<AuthenticatedRequest>().entityContext;
  if (!entity) throw new Error('CurrentEntity used without @EntityAccess');
  return entity;
});
