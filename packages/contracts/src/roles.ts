import { z } from 'zod';

/** Platform roles: not tied to an entity (SPEC.md §2.1). */
export const PLATFORM_ROLES = [
  'platform_admin',
  'platform_reviewer',
  'regulator',
  'auditor',
] as const;
/** Roles inside an entity, granted through a membership (SPEC.md §2.2). */
export const ENTITY_ROLES = [
  'entity_admin',
  'api_publisher',
  'data_steward',
  'app_developer',
  'entity_viewer',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type EntityRole = (typeof ENTITY_ROLES)[number];
export type Role = PlatformRole | EntityRole;

export const platformRoleSchema = z.enum(PLATFORM_ROLES);
export const entityRoleSchema = z.enum(ENTITY_ROLES);
export const roleSchema = z.enum([...PLATFORM_ROLES, ...ENTITY_ROLES]);

export const isPlatformRole = (role: string): role is PlatformRole =>
  (PLATFORM_ROLES as readonly string[]).includes(role);
export const isEntityRole = (role: string): role is EntityRole =>
  (ENTITY_ROLES as readonly string[]).includes(role);
