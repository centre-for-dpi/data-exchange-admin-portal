import { describe, expect, it, vi } from 'vitest';
import {
  CLI_ACTOR,
  grantPlatformRole,
  listPlatformRoles,
  PlatformRoleError,
  revokePlatformRole,
} from './platform-roles.js';

/**
 * Platform roles from the server's command line: the operator's way to give its own people the
 * roles that no screen grants (operator, reviewer, regulator, auditor), audited like any change.
 */
type Row = { userId: string; role: string; grantedBy: string };

function setup({
  users = [{ id: 'u1', email: 'ana@operador.example', fullName: 'Ana', status: 'active' }],
  roles = [] as Row[],
} = {}) {
  const state = { roles: [...roles] };
  type Key = { where: { userId_role: { userId: string; role: string } } };
  const sameKey = (r: Row, { where }: Key) =>
    r.userId === where.userId_role.userId && r.role === where.userId_role.role;
  // Fakes of the Prisma calls the module makes; they answer at once, as resolved promises.
  const tx = {
    user: {
      findUnique: vi.fn(({ where }: { where: { email: string } }) =>
        Promise.resolve(users.find((u) => u.email === where.email) ?? null),
      ),
    },
    userPlatformRole: {
      findUnique: vi.fn((key: Key) =>
        Promise.resolve(state.roles.find((r) => sameKey(r, key)) ?? null),
      ),
      create: vi.fn(({ data }: { data: Row }) => {
        state.roles.push(data);
        return Promise.resolve(data);
      }),
      delete: vi.fn((key: Key) => {
        state.roles = state.roles.filter((r) => !sameKey(r, key));
        return Promise.resolve();
      }),
      count: vi.fn(({ where }: { where: { role: string } }) =>
        Promise.resolve(state.roles.filter((r) => r.role === where.role).length),
      ),
      findMany: vi.fn(() =>
        Promise.resolve(
          state.roles.map((r) => ({
            ...r,
            createdAt: new Date('2026-11-18T12:00:00Z'),
            user: users.find((u) => u.id === r.userId),
          })),
        ),
      ),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(<T>(fn: (t: typeof tx) => Promise<T>) => fn(tx)),
  } as unknown as Parameters<typeof grantPlatformRole>[0];
  const audit = { record: vi.fn() };
  return { prisma, audit, state, tx };
}

describe('grantPlatformRole', () => {
  it('grants the role to a person who has signed in, audited as the command line', async () => {
    const { prisma, audit, state } = setup();
    const result = await grantPlatformRole(prisma, audit, {
      email: ' Ana@Operador.example ',
      role: 'platform_reviewer',
      reason: 'Equipo de revisión de la AND',
    });
    expect(result).toEqual({
      outcome: 'granted',
      email: 'ana@operador.example',
      role: 'platform_reviewer',
    });
    expect(state.roles).toEqual([
      { userId: 'u1', role: 'platform_reviewer', grantedBy: CLI_ACTOR.id },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: CLI_ACTOR,
        action: 'platform_role.granted',
        target: { type: 'user', id: 'u1' },
        after: { role: 'platform_reviewer', reason: 'Equipo de revisión de la AND' },
      }),
    );
  });

  it('is idempotent: a role the person already has changes nothing and records nothing', async () => {
    const { prisma, audit, tx } = setup({
      roles: [{ userId: 'u1', role: 'regulator', grantedBy: 'seed' }],
    });
    const result = await grantPlatformRole(prisma, audit, {
      email: 'ana@operador.example',
      role: 'regulator',
    });
    expect(result.outcome).toBe('unchanged');
    expect(tx.userPlatformRole.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses an address that has no portal account yet, and says what to do', async () => {
    const { prisma, audit } = setup();
    await expect(
      grantPlatformRole(prisma, audit, { email: 'nadie@operador.example', role: 'auditor' }),
    ).rejects.toThrow(/register.*sign in once/i);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a role that is not a platform role', async () => {
    const { prisma, audit } = setup();
    await expect(
      grantPlatformRole(prisma, audit, { email: 'ana@operador.example', role: 'entity_admin' }),
    ).rejects.toThrow(PlatformRoleError);
    await expect(
      grantPlatformRole(prisma, audit, { email: 'ana@operador.example', role: 'root' }),
    ).rejects.toThrow(/platform_admin, platform_reviewer, regulator, auditor/);
  });

  it('refuses a disabled account', async () => {
    const { prisma, audit } = setup({
      users: [{ id: 'u1', email: 'ana@operador.example', fullName: 'Ana', status: 'disabled' }],
    });
    await expect(
      grantPlatformRole(prisma, audit, { email: 'ana@operador.example', role: 'auditor' }),
    ).rejects.toThrow(/disabled/);
  });
});

describe('revokePlatformRole', () => {
  it('revokes the role, audited, with the role it had before', async () => {
    const { prisma, audit, state } = setup({
      roles: [{ userId: 'u1', role: 'auditor', grantedBy: CLI_ACTOR.id }],
    });
    const result = await revokePlatformRole(prisma, audit, {
      email: 'ana@operador.example',
      role: 'auditor',
      reason: 'Dejó el equipo',
    });
    expect(result.outcome).toBe('revoked');
    expect(state.roles).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: CLI_ACTOR,
        action: 'platform_role.revoked',
        target: { type: 'user', id: 'u1' },
        before: { role: 'auditor' },
        after: { reason: 'Dejó el equipo' },
      }),
    );
  });

  it('a role the person does not have changes nothing', async () => {
    const { prisma, audit } = setup();
    const result = await revokePlatformRole(prisma, audit, {
      email: 'ana@operador.example',
      role: 'auditor',
    });
    expect(result.outcome).toBe('unchanged');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('never leaves the network without a platform administrator', async () => {
    const { prisma, audit, state } = setup({
      roles: [{ userId: 'u1', role: 'platform_admin', grantedBy: 'seed' }],
    });
    await expect(
      revokePlatformRole(prisma, audit, { email: 'ana@operador.example', role: 'platform_admin' }),
    ).rejects.toThrow(/last platform_admin/);
    expect(state.roles).toHaveLength(1);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('listPlatformRoles', () => {
  it('lists who holds each platform role, with who granted it', async () => {
    const { prisma } = setup({
      roles: [{ userId: 'u1', role: 'platform_admin', grantedBy: 'cli:platform-roles' }],
    });
    expect(await listPlatformRoles(prisma)).toEqual([
      {
        email: 'ana@operador.example',
        fullName: 'Ana',
        status: 'active',
        role: 'platform_admin',
        grantedBy: 'cli:platform-roles',
        grantedAt: '2026-11-18T12:00:00.000Z',
      },
    ]);
  });
});
