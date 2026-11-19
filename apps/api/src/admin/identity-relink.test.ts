import { describe, expect, it, vi } from 'vitest';
import { runIdentityRelinkCli } from './identity-relink-cli.js';
import { IdentityRelinkError, RELINK_ACTOR, relinkIdentity } from './identity-relink.js';

/** B-22: pointing an existing portal account at a new Keycloak user or address, audited. */
const OLD_SUB = '0193a6c0-0000-7000-8000-000000000001';
const NEW_SUB = '0193a6c0-0000-7000-8000-0000000000aa';
const REASON = 'Pidió el cambio por oficio 123';

type User = { id: string; keycloakSub: string; email: string };

function setup(
  users: User[] = [{ id: 'u1', keycloakSub: OLD_SUB, email: 'ana@operador.example' }],
) {
  const rows = users.map((u) => ({ ...u }));
  const tx = {
    user: {
      findUnique: vi.fn(({ where }: { where: { email?: string; keycloakSub?: string } }) => {
        const found = rows.find(
          (u) => u.email === where.email || u.keycloakSub === where.keycloakSub,
        );
        return Promise.resolve(found ? { ...found } : null);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Partial<User> }) => {
        Object.assign(rows.find((u) => u.id === where.id) ?? {}, data);
        return Promise.resolve();
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(<T>(fn: (t: typeof tx) => Promise<T>) => fn(tx)),
  } as unknown as Parameters<typeof relinkIdentity>[0];
  return { prisma, audit: { record: vi.fn() }, rows, tx };
}

describe('relinkIdentity', () => {
  it('points the account at the new Keycloak user and audits before and after', async () => {
    const { prisma, audit, rows } = setup();
    const result = await relinkIdentity(prisma, audit, {
      email: ' Ana@Operador.example ',
      newSub: NEW_SUB,
      reason: REASON,
    });
    expect(result).toMatchObject({ outcome: 'relinked', keycloakSub: NEW_SUB });
    expect(rows[0]).toMatchObject({
      id: 'u1',
      keycloakSub: NEW_SUB,
      email: 'ana@operador.example',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: RELINK_ACTOR,
        action: 'user.identity_relinked',
        target: { type: 'user', id: 'u1' },
        before: { keycloakSub: OLD_SUB, email: 'ana@operador.example' },
        after: { keycloakSub: NEW_SUB, email: 'ana@operador.example', reason: REASON },
      }),
    );
  });

  it('changes the address alone, or both', async () => {
    const { prisma, audit, rows } = setup();
    await relinkIdentity(prisma, audit, {
      email: 'ana@operador.example',
      newEmail: 'Ana.Nueva@Operador.example',
      reason: REASON,
    });
    expect(rows[0]).toMatchObject({ keycloakSub: OLD_SUB, email: 'ana.nueva@operador.example' });
  });

  it('changes nothing when the account already has that identity', async () => {
    const { prisma, audit, tx } = setup();
    const result = await relinkIdentity(prisma, audit, {
      email: 'ana@operador.example',
      newSub: OLD_SUB,
      reason: REASON,
    });
    expect(result.outcome).toBe('unchanged');
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['no new identity', { email: 'ana@operador.example', reason: REASON }, /--sub/],
    [
      'a reason that is too short',
      { email: 'ana@operador.example', newSub: NEW_SUB, reason: 'sí' },
      /reason/,
    ],
    [
      'a sub that is not an ID',
      { email: 'ana@operador.example', newSub: 'ana', reason: REASON },
      /Keycloak user ID/,
    ],
    [
      'an unknown account',
      { email: 'nadie@operador.example', newSub: NEW_SUB, reason: REASON },
      /No portal account/,
    ],
  ])('refuses %s', async (_name, change, message) => {
    const { prisma, audit } = setup();
    await expect(relinkIdentity(prisma, audit, change)).rejects.toThrow(message);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses an identity or address another account already uses', async () => {
    const { prisma, audit, rows } = setup([
      { id: 'u1', keycloakSub: OLD_SUB, email: 'ana@operador.example' },
      { id: 'u2', keycloakSub: NEW_SUB, email: 'otra@operador.example' },
    ]);
    await expect(
      relinkIdentity(prisma, audit, {
        email: 'ana@operador.example',
        newSub: NEW_SUB,
        reason: REASON,
      }),
    ).rejects.toBeInstanceOf(IdentityRelinkError);
    await expect(
      relinkIdentity(prisma, audit, {
        email: 'ana@operador.example',
        newEmail: 'otra@operador.example',
        reason: REASON,
      }),
    ).rejects.toThrow(/already uses/);
    expect(rows[0]?.keycloakSub).toBe(OLD_SUB);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('identity-relink command line', () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const relink = vi.fn((c: { email: string }) =>
      Promise.resolve({
        outcome: 'relinked' as const,
        userId: 'u1',
        email: c.email,
        keycloakSub: NEW_SUB,
      }),
    );
    const code = await runIdentityRelinkCli(argv, {
      relink,
      print: (l) => out.push(l),
      printError: (l) => err.push(l),
    });
    return { code, out, err, relink };
  };

  it('passes the options through and reports the result', async () => {
    const { code, out, relink } = await run([
      'ana@operador.example',
      '--sub',
      NEW_SUB,
      '--reason',
      REASON,
    ]);
    expect(code).toBe(0);
    expect(relink).toHaveBeenCalledWith({
      email: 'ana@operador.example',
      newSub: NEW_SUB,
      newEmail: undefined,
      reason: REASON,
    });
    expect(out[0]).toContain('relinked');
  });

  it('prints the usage for a missing e-mail or an unknown option, and the refusal as an error', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['a@b.co', '--nope'])).code).toBe(2);
    const refused = await runIdentityRelinkCli(['a@b.co'], {
      relink: () => Promise.reject(new IdentityRelinkError('nope')),
      print: () => undefined,
      printError: () => undefined,
    });
    expect(refused).toBe(1);
  });
});
