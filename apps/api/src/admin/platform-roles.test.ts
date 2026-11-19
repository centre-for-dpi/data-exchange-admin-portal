import { describe, expect, it, vi } from 'vitest';
import {
  CLI_ACTOR,
  grantPlatformRole,
  listPlatformRoles,
  PlatformRoleError,
  revokePlatformRole,
  setUserStatus,
} from './platform-roles.js';

/**
 * Platform roles from the server's command line: the operator's way to give its own people the
 * roles that no screen grants (operator, reviewer, regulator, auditor), audited like any change.
 */
type Row = { userId: string; role: string; grantedBy: string };

function setup({
  users = [
    { id: 'u1', email: 'ana@operador.example', fullName: 'Ana', status: 'active' },
  ] as Array<{ id: string; email: string; fullName: string; status: string }>,
  roles = [] as Row[],
} = {}) {
  const state = { roles: [...roles], users: users.map((u) => ({ ...u })) };
  type Key = { where: { userId_role: { userId: string; role: string } } };
  const sameKey = (r: Row, { where }: Key) =>
    r.userId === where.userId_role.userId && r.role === where.userId_role.role;
  // Fakes of the Prisma calls the module makes; they answer at once, as resolved promises.
  const tx = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    user: {
      findUnique: vi.fn(({ where }: { where: { email: string } }) => {
        const user = state.users.find((u) => u.email === where.email);
        return Promise.resolve(
          user ? { ...user, platformRoles: state.roles.filter((r) => r.userId === user.id) } : null,
        );
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: { status: string } }) => {
        const user = state.users.find((u) => u.id === where.id);
        if (user) user.status = data.status;
        return Promise.resolve(user);
      }),
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
      count: vi.fn(
        ({
          where,
        }: {
          where: { role: string; userId?: { not: string }; user?: { status: string } };
        }) =>
          Promise.resolve(
            state.roles.filter(
              (r) =>
                r.role === where.role &&
                (!where.userId || r.userId !== where.userId.not) &&
                (!where.user ||
                  state.users.find((u) => u.id === r.userId)?.status === where.user.status),
            ).length,
          ),
      ),
      findMany: vi.fn(() =>
        Promise.resolve(
          state.roles.map((r) => ({
            ...r,
            createdAt: new Date('2026-11-18T12:00:00Z'),
            user: state.users.find((u) => u.id === r.userId),
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

describe('as a signed-in administrator (M-03)', () => {
  const admin = { type: 'user' as const, id: 'sub-of-the-admin' };
  const two = {
    users: [
      { id: 'u1', email: 'ana@operador.example', fullName: 'Ana', status: 'active' },
      { id: 'u2', email: 'pablo@operador.example', fullName: 'Pablo', status: 'active' },
    ],
    roles: [
      { userId: 'u1', role: 'platform_admin', grantedBy: 'seed' },
      { userId: 'u2', role: 'platform_admin', grantedBy: 'seed' },
    ],
  };

  it('records the administrator as the actor and as who granted the role', async () => {
    const { prisma, audit, state } = setup();
    await grantPlatformRole(prisma, audit, {
      email: 'ana@operador.example',
      role: 'regulator',
      reason: 'Designada por la resolución 12',
      actor: admin,
    });
    expect(state.roles).toEqual([{ userId: 'u1', role: 'regulator', grantedBy: admin.id }]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: admin, action: 'platform_role.granted' }),
    );
  });

  it('lets an administrator go while another active one remains', async () => {
    const { prisma, audit, state } = setup(two);
    await revokePlatformRole(prisma, audit, {
      email: 'ana@operador.example',
      role: 'platform_admin',
      actor: admin,
    });
    expect(state.roles.map((r) => r.userId)).toEqual(['u2']);
  });

  it('does not count a disabled administrator as the one who remains', async () => {
    const { prisma, audit, state } = setup({
      ...two,
      users: [two.users[0]!, { ...two.users[1]!, status: 'disabled' }],
    });
    await expect(
      revokePlatformRole(prisma, audit, { email: 'ana@operador.example', role: 'platform_admin' }),
    ).rejects.toMatchObject({ kind: 'last_platform_admin' });
    expect(state.roles).toHaveLength(2);
  });

  it('disables and enables an account, audited with the reason', async () => {
    const { prisma, audit, state } = setup();
    const off = await setUserStatus(
      prisma,
      audit,
      { email: 'Ana@Operador.example', reason: 'Cuenta comprometida', actor: admin },
      'disabled',
    );
    expect(off).toEqual({ outcome: 'disabled', email: 'ana@operador.example', status: 'disabled' });
    expect(state.users[0]?.status).toBe('disabled');
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: admin,
        action: 'user.disabled',
        before: { status: 'active' },
        after: { status: 'disabled', reason: 'Cuenta comprometida' },
      }),
    );
    const on = await setUserStatus(
      prisma,
      audit,
      { email: 'ana@operador.example', reason: 'Falsa alarma', actor: admin },
      'active',
    );
    expect(on.outcome).toBe('enabled');
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.enabled' }),
    );
  });

  it('a status that is already the one asked changes nothing and records nothing', async () => {
    const { prisma, audit } = setup();
    const result = await setUserStatus(prisma, audit, { email: 'ana@operador.example' }, 'active');
    expect(result.outcome).toBe('unchanged');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to disable the last active administrator, and an unknown account', async () => {
    const { prisma, audit, state } = setup({
      roles: [{ userId: 'u1', role: 'platform_admin', grantedBy: 'seed' }],
    });
    await expect(
      setUserStatus(prisma, audit, { email: 'ana@operador.example' }, 'disabled'),
    ).rejects.toMatchObject({ kind: 'last_platform_admin' });
    expect(state.users[0]?.status).toBe('active');
    await expect(
      setUserStatus(prisma, audit, { email: 'nadie@operador.example' }, 'disabled'),
    ).rejects.toMatchObject({ kind: 'unknown_account' });
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
        userId: 'u1',
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
