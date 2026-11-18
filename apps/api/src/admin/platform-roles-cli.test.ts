import { describe, expect, it, vi } from 'vitest';
import { runPlatformRolesCli } from './platform-roles-cli.js';
import { PlatformRoleError } from './platform-roles.js';

function deps(overrides: Partial<Parameters<typeof runPlatformRolesCli>[1]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    d: {
      grant: vi.fn((c: { email: string; role: string }) =>
        Promise.resolve({ outcome: 'granted' as const, email: c.email, role: c.role as 'auditor' }),
      ),
      revoke: vi.fn((c: { email: string; role: string }) =>
        Promise.resolve({ outcome: 'revoked' as const, email: c.email, role: c.role as 'auditor' }),
      ),
      list: vi.fn(() =>
        Promise.resolve([
          {
            email: 'ana@operador.example',
            fullName: 'Ana',
            status: 'active',
            role: 'platform_admin' as const,
            grantedBy: 'cli:platform-roles',
            grantedAt: '2026-11-18T12:00:00.000Z',
          },
        ]),
      ),
      print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line),
      ...overrides,
    },
  };
}

describe('platform-roles command line', () => {
  it('grant <email> <role> [--reason] passes them on and prints the outcome', async () => {
    const { d, out } = deps();
    const code = await runPlatformRolesCli(
      ['grant', 'ana@operador.example', 'auditor', '--reason', 'Equipo de auditoría'],
      d,
    );
    expect(code).toBe(0);
    expect(d.grant).toHaveBeenCalledWith({
      email: 'ana@operador.example',
      role: 'auditor',
      reason: 'Equipo de auditoría',
    });
    expect(out.join('\n')).toMatch(/granted: auditor to ana@operador\.example/);
  });

  it('revoke <email> <role> passes them on', async () => {
    const { d, out } = deps();
    expect(await runPlatformRolesCli(['revoke', 'ana@operador.example', 'auditor'], d)).toBe(0);
    expect(d.revoke).toHaveBeenCalledWith({
      email: 'ana@operador.example',
      role: 'auditor',
      reason: undefined,
    });
    expect(out.join('\n')).toMatch(/revoked: auditor from ana@operador\.example/);
  });

  it('list prints one line per holder', async () => {
    const { d, out } = deps();
    expect(await runPlatformRolesCli(['list'], d)).toBe(0);
    expect(out.join('\n')).toMatch(/platform_admin\s+ana@operador\.example\s+Ana/);
  });

  it('a missing argument or an unknown command prints the usage and exits 2', async () => {
    for (const argv of [[], ['grant', 'ana@operador.example'], ['promote', 'x', 'y']]) {
      const { d, err } = deps();
      expect(await runPlatformRolesCli(argv, d)).toBe(2);
      expect(err.join('\n')).toMatch(/usage: platform-roles/);
      expect(d.grant).not.toHaveBeenCalled();
    }
  });

  it('a refused change prints the reason and exits 1, without a stack trace', async () => {
    const { d, err } = deps({
      grant: vi.fn(() =>
        Promise.reject(new PlatformRoleError('No portal account with nadie@x.example')),
      ),
    });
    expect(await runPlatformRolesCli(['grant', 'nadie@x.example', 'auditor'], d)).toBe(1);
    expect(err.join('\n')).toBe('error: No portal account with nadie@x.example');
  });
});
