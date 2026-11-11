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
} as const satisfies Record<string, EntityPermission>;

export type EntityAction = keyof typeof ENTITY_PERMISSIONS;
