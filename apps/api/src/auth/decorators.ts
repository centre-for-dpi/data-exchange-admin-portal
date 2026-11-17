import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { EntityRole } from '@den/contracts';
import type { EntityAction, PlatformAction } from './authz.policy.js';
import type { Principal } from './principal.service.js';

export const IS_PUBLIC = 'den:public';
export const ENTITY_ACTION = 'den:entity-action';
export const PLATFORM_ACTION = 'den:platform-action';
export const OPTIONAL_AUTH = 'den:optional-auth';
export const SIGNED_IN = 'den:signed-in';
export const CITIZEN = 'den:citizen';
export const NODE = 'den:node';

/** Endpoint that does not require authentication (health checks). Everything else does. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Endpoint on a resource owned by the entity in the `:entityId` route param. The guard returns
 * 404 to callers outside that entity (and without a platform role allowed for the action), and
 * 403 to members whose roles do not allow it (CLAUDE.md, definition of done).
 */
export const EntityAccess = (action: EntityAction) => SetMetadata(ENTITY_ACTION, action);

/**
 * Endpoint that also answers anonymous callers (no Authorization header): the handler decides what
 * they may see (public catalogue, SPEC.md §2.3). A present but invalid token is still a 401.
 */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);

/**
 * Endpoint for any signed-in portal user, with or without roles: the handler only ever returns
 * or changes the caller's own resources (their session, invitations, onboarding requests) or
 * data every user may read. Ownership is enforced in the service, with 404 for anything else.
 */
export const SignedIn = () => SetMetadata(SIGNED_IN, true);

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

/** How a route is accessed: every route declares exactly one (checked by tests and the guard). */
export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'citizen' }
  | { kind: 'node' }
  | { kind: 'optional' }
  | { kind: 'signedIn' }
  | { kind: 'entity'; action: EntityAction }
  | { kind: 'platform'; action: PlatformAction }
  | { kind: 'undeclared' };

interface MetadataReader {
  getAllAndOverride<T>(key: string, targets: Array<object>): T | undefined;
}

/** Reads the access declaration of a handler (method metadata wins over the controller's). */
export function routeAccess(reflector: MetadataReader, targets: Array<object>): RouteAccess {
  const entity = reflector.getAllAndOverride<EntityAction>(ENTITY_ACTION, targets);
  if (entity) return { kind: 'entity', action: entity };
  const platform = reflector.getAllAndOverride<PlatformAction>(PLATFORM_ACTION, targets);
  if (platform) return { kind: 'platform', action: platform };
  if (reflector.getAllAndOverride<boolean>(CITIZEN, targets)) return { kind: 'citizen' };
  if (reflector.getAllAndOverride<boolean>(NODE, targets)) return { kind: 'node' };
  if (reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return { kind: 'public' };
  if (reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, targets)) return { kind: 'optional' };
  if (reflector.getAllAndOverride<boolean>(SIGNED_IN, targets)) return { kind: 'signedIn' };
  return { kind: 'undeclared' };
}
