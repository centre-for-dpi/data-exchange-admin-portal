import { ENTITY_ROLES, type EntityRole, PLATFORM_ROLES, type PlatformRole } from '@den/contracts';

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
  /** Invite people, change members' roles and revoke memberships (SPEC.md §2.2, M2-02). */
  'entity.members.write': {
    entityRoles: ['entity_admin'],
    platformRoles: [],
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
  /**
   * Suspend, reactivate or revoke a subscription to the entity's APIs: the data steward, and the
   * operator or the regulator for any entity (SPEC.md §4.4 step 5, M2-06).
   */
  'access_request.suspend': {
    entityRoles: ['data_steward'],
    platformRoles: ['platform_admin', 'regulator'],
  },
  /** Choose which catalogue purposes the entity's API versions allow (SPEC.md §2.2, M2-10). */
  'api.purposes.write': {
    entityRoles: ['data_steward'],
    platformRoles: [],
  },
  /**
   * See the entity's nodes of the kit and their enrollment tokens (never a token itself). The
   * reviewer sees them too: API versions on a node show its state (SPEC.md §4.6).
   */
  'node.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: ['platform_admin', 'platform_reviewer', 'regulator'],
  },
  /** Issue and revoke enrollment tokens, decommission nodes (SPEC.md §4.6 step 1). */
  'node.write': {
    entityRoles: ['entity_admin'],
    platformRoles: ['platform_admin'],
  },
  /** The entity's bootcamp readiness (M4-07): members and whoever supports the bootcamp. */
  'bootcamp.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: ['platform_admin', 'platform_reviewer', 'regulator'],
  },
  /** Confirm the prerequisites of the bootcamp (the entity's admin, or the operator with it). */
  'bootcamp.write': {
    entityRoles: ['entity_admin'],
    platformRoles: ['platform_admin'],
  },
  /**
   * Usage of the entity's APIs (M5-02): who calls them, for what and how they answer. Like the
   * provider inbox: whoever looks after the entity's APIs, and the operator and the regulator.
   */
  'usage.provided.read': {
    entityRoles: ['data_steward', 'entity_admin', 'entity_viewer', 'api_publisher'],
    platformRoles: ['platform_admin', 'platform_reviewer', 'regulator'],
  },
  /**
   * Usage of the entity's applications (M5-03): their calls and the gateway's refusals with
   * their reason. Like the applications themselves: any member, the operator and the regulator.
   */
  'usage.consumed.read': {
    entityRoles: ENTITY_ROLES,
    platformRoles: ['platform_admin', 'platform_reviewer', 'regulator'],
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
  /** Approve or request changes on a version (operator). The regulator step is regulator.decide. */
  'review.decide': ['platform_admin', 'platform_reviewer'],
  /** See onboarding requests of entities and their designation documents (SPEC.md §4.1). */
  'entity_review.read': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** Approve, send back or reject an onboarding request (operator). */
  'entity_review.decide': ['platform_admin', 'platform_reviewer'],
  /** The regulator's inbox: sensitive publications and access requests waiting for it (M2-04). */
  'regulator.read': ['regulator'],
  /** Approve, or send back / reject, what features.approval.regulatorForSensitive routes to it. */
  'regulator.decide': ['regulator'],
  /** See every entity of the network with its status (operator console, M2-11). */
  'entity_admin.read': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** Suspend, reactivate or offboard an entity (SPEC.md §2.1: "suspender cualquier cosa"). */
  'entity_admin.decide': ['platform_admin'],
  /** Revoke client certificates of any entity at once, in an incident (M6-07, RUNBOOK.md). */
  'certificate.mass_revoke': ['platform_admin'],
  /** Rotate the signing key of the gateway's assertions now, e.g. after a compromise (M6-10). */
  'gateway_key.rotate': ['platform_admin'],
  /** Register an entity directly, without an onboarding request (SPEC.md §4.1 step 1). */
  'entity_admin.create': ['platform_admin'],
  /** See the whole purpose catalogue, inactive purposes and their use included (M2-10). */
  'purpose.read': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** Add, edit, deactivate and reactivate purposes of the catalogue (operator). */
  'purpose.manage': ['platform_admin', 'platform_reviewer'],
  /** Delete a document's bytes by legal order, the only physical deletion (SPEC.md §5). */
  'document.purge': ['platform_admin'],
  /** Register of attached documents (metadata only), to find the one a legal order names. */
  'document.list': ['platform_admin'],
  /** Every node of the network with its state, version and last heartbeat (SPEC.md §6). */
  'node.list': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** Readiness of every entity for the bootcamp (operator console, M4-07). */
  'bootcamp.list': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** The network's indicators (SPEC.md §8, M5-04): the regulator and the operator. */
  'network.indicators.read': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** The sync console (M5-07): what the reconcilers keep and the drift they found (operator). */
  'sync.read': ['platform_admin', 'platform_reviewer'],
  /** Reconcile one target now: queues the reconciler's job (operator admin). */
  'sync.retry': ['platform_admin'],
  /** The exchange map (M5-05): which entity consumes from which, with volume. */
  'network.map.read': ['platform_admin', 'platform_reviewer', 'regulator'],
  /** The releases of the node kit the operator has offered, newest first (P-03). */
  'kit_release.read': ['platform_admin', 'platform_reviewer'],
  /** Set the kit's current version, correct it and mirror its bundle (operator admin, P-03). */
  'kit_release.manage': ['platform_admin'],
  /** Audit trail of the whole network and verification of its hash chain (SPEC.md §6). */
  'audit.read': ['platform_admin', 'platform_reviewer', 'regulator', 'auditor'],
} as const satisfies Record<string, readonly PlatformRole[]>;

export type PlatformAction = keyof typeof PLATFORM_PERMISSIONS;

/**
 * Roles that require a second factor (SPEC.md §8, M3-08, ADR-0021): every platform role, which
 * acts on the whole network, and the data steward, who decides who gets an entity's data.
 */
export const MFA_PLATFORM_ROLES: readonly PlatformRole[] = PLATFORM_ROLES;
export const MFA_ENTITY_ROLES: readonly EntityRole[] = ['data_steward'];

/**
 * A user with one of those roles (in any entity) needs the second factor for every role-based
 * endpoint: the requirement belongs to the person, like the Keycloak session it applies to.
 */
export function requiresMfa(
  platformRoles: readonly PlatformRole[],
  memberships: ReadonlyArray<{ roles: readonly EntityRole[] }>,
): boolean {
  return (
    platformRoles.some((role) => MFA_PLATFORM_ROLES.includes(role)) ||
    memberships.some((m) => m.roles.some((role) => MFA_ENTITY_ROLES.includes(role)))
  );
}
