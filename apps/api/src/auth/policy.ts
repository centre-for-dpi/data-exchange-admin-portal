import { ENTITY_ROLES, type EntityRole, type PlatformRole } from '@rid/contracts';

/**
 * Who may do what on resources that belong to an entity (SPEC.md §2). Evaluated in the backend on
 * every request (CLAUDE.md, rule 3). M2-03 grows this into the full matrix with one generated
 * test per endpoint and role.
 *
 * - `entityRoles`: roles of an active membership in the entity from the URL.
 * - `platformRoles`: platform roles that may act on any entity.
 */
export interface EntityPermission {
  entityRoles: readonly EntityRole[];
  platformRoles: readonly PlatformRole[];
}

export const ENTITY_PERMISSIONS = {
  /** See the entity's data. Any member; operator and regulator for any entity. */
  'entity.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: ['platform_admin', 'platform_reviewer', 'regulator'],
  },
  /** List members (names, e-mails, roles): personal data, so only admins and viewers. */
  'entity.members.read': {
    entityRoles: ['entity_admin', 'entity_viewer'],
    platformRoles: ['platform_admin', 'regulator'],
  },
  /** See the entity's APIs and versions, including drafts. */
  'api.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: ['platform_admin', 'platform_reviewer', 'regulator'],
  },
  /** Register APIs and versions, edit drafts and submit them for review (SPEC.md §2.2). */
  'api.write': {
    entityRoles: ['api_publisher'],
    platformRoles: [],
  },
  /** See the entity's consumer applications (never their secrets). */
  'application.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: ['platform_admin', 'regulator'],
  },
  /** Create applications and manage their credentials (SPEC.md §2.2). */
  'application.write': {
    entityRoles: ['app_developer'],
    platformRoles: [],
  },
  /** See the access requests the entity made as a consumer, and their status. */
  'subscription.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: ['platform_admin', 'regulator'],
  },
  /** Ask for access to an API on behalf of one of the entity's applications (SPEC.md §2.2). */
  'subscription.write': {
    entityRoles: ['app_developer'],
    platformRoles: [],
  },
  /** See the access requests other entities made to this entity's APIs (provider inbox). */
  'access_request.read': {
    entityRoles: ['data_steward', 'entity_admin', 'entity_viewer', 'api_publisher'],
    platformRoles: ['platform_admin', 'regulator'],
  },
  /** Approve or reject access requests to the entity's APIs (SPEC.md §2.2). */
  'access_request.decide': {
    entityRoles: ['data_steward'],
    platformRoles: [],
  },
  /** Timeline of the entity's own objects (its APIs, subscriptions it asked for or received). */
  'audit.entity.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: [],
  },
} as const satisfies Record<string, EntityPermission>;

export type EntityAction = keyof typeof ENTITY_PERMISSIONS;

/**
 * Actions on platform-wide resources (not owned by one entity). Users without one of the roles get
 * 403. Grows into the full matrix in M2-03.
 */
export const PLATFORM_PERMISSIONS = {
  /** See the review queue and versions under review, from any entity. */
  'review.read': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** Approve or request changes on a version (operator). The regulator step is M2-04. */
  'review.decide': ['platform_admin', 'platform_reviewer'],
  /** Audit trail of the whole network and verification of its hash chain (SPEC.md §6). */
  'audit.read': ['platform_admin', 'platform_reviewer', 'regulator', 'auditor'],
} as const satisfies Record<string, readonly PlatformRole[]>;

export type PlatformAction = keyof typeof PLATFORM_PERMISSIONS;
