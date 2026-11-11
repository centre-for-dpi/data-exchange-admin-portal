import { describe, expect, it } from 'vitest';
import { ENTITY_ROLES, PLATFORM_ROLES, isEntityRole, isPlatformRole, roleSchema } from './roles.js';

describe('roles', () => {
  it('keeps platform and entity roles disjoint', () => {
    const overlap = PLATFORM_ROLES.filter((r) => (ENTITY_ROLES as readonly string[]).includes(r));
    expect(overlap).toEqual([]);
  });

  it('classifies roles', () => {
    expect(isPlatformRole('regulator')).toBe(true);
    expect(isEntityRole('regulator')).toBe(false);
    expect(isEntityRole('data_steward')).toBe(true);
  });

  it('rejects unknown roles', () => {
    expect(roleSchema.safeParse('superuser').success).toBe(false);
  });
});
