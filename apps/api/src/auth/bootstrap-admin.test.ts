import { describe, expect, it, vi } from 'vitest';
import { bootstrapPlatformAdmin } from './bootstrap-admin.js';

/** The first platform administrator of a production network (M6-05). */
describe('bootstrapPlatformAdmin', () => {
  const setup = (existingAdmins: number) => {
    const create = vi.fn();
    const tx = {
      userPlatformRole: { count: vi.fn().mockResolvedValue(existingAdmins), create },
    } as unknown as Parameters<typeof bootstrapPlatformAdmin>[0];
    const audit = { record: vi.fn() };
    return { tx, audit, create };
  };
  const candidate = { userId: 'u1', email: 'Admin@Example.org', emailVerified: true };

  it('grants platform_admin, audited, to the configured address when there is none', async () => {
    const { tx, audit, create } = setup(0);
    expect(await bootstrapPlatformAdmin(tx, audit, candidate, ' admin@example.org ', 'r1')).toBe(
      true,
    );
    expect(create).toHaveBeenCalledWith({
      data: { userId: 'u1', role: 'platform_admin', grantedBy: 'bootstrap-admin' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actor: { type: 'system', id: 'bootstrap-admin' },
        action: 'platform_role.granted',
        target: { type: 'user', id: 'u1' },
      }),
    );
  });

  it('does nothing once the network has a platform administrator', async () => {
    const { tx, audit, create } = setup(1);
    expect(await bootstrapPlatformAdmin(tx, audit, candidate, 'admin@example.org')).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('needs the address verified by the identity provider', async () => {
    const { tx, audit, create } = setup(0);
    const unverified = { ...candidate, emailVerified: false };
    expect(await bootstrapPlatformAdmin(tx, audit, unverified, 'admin@example.org')).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('ignores other addresses and an unset variable', async () => {
    const { tx, audit, create } = setup(0);
    expect(await bootstrapPlatformAdmin(tx, audit, candidate, 'other@example.org')).toBe(false);
    expect(await bootstrapPlatformAdmin(tx, audit, candidate, undefined)).toBe(false);
    expect(await bootstrapPlatformAdmin(tx, audit, candidate, '')).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
