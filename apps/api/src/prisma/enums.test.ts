import { ENTITY_ROLES, PLATFORM_ROLES } from '@den/contracts';
import { describe, expect, it } from 'vitest';
import { EntityRole, PlatformRole } from '../generated/prisma/enums.js';

// Roles exist in two places: Prisma enums (database) and packages/contracts (web + API).
describe('role enums', () => {
  it('match between the database schema and the shared contracts', () => {
    expect(Object.values(PlatformRole).sort()).toEqual([...PLATFORM_ROLES].sort());
    expect(Object.values(EntityRole).sort()).toEqual([...ENTITY_ROLES].sort());
  });
});
