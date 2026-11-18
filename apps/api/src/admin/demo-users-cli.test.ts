import { describe, expect, it, vi } from 'vitest';
import { runDemoUsersCli } from './demo-users-cli.js';
import { DemoUsersError } from './demo-users.js';

function deps(overrides: Partial<Parameters<typeof runDemoUsersCli>[1]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    d: {
      list: vi.fn(() =>
        Promise.resolve([
          {
            username: 'pablo.plataforma',
            email: 'pablo.plataforma@demo.den.example',
            portal: 'active' as const,
            platformRoles: ['platform_admin' as const],
            keycloak: 'enabled' as const,
          },
        ]),
      ),
      disable: vi.fn(() =>
        Promise.resolve({
          users: [
            {
              username: 'pablo.plataforma',
              email: 'pablo.plataforma@demo.den.example',
              portal: 'disabled' as const,
              rolesRevoked: ['platform_admin' as const],
              keycloak: 'disabled' as const,
            },
          ],
          warnings: ['nobody holds auditor now: grant it with platform-role grant <email> auditor'],
        }),
      ),
      print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line),
      ...overrides,
    },
  };
}

describe('demo-users command line (P-08)', () => {
  it('list prints each demo user with its portal and Keycloak state', async () => {
    const { d, out } = deps();
    expect(await runDemoUsersCli(['list'], d)).toBe(0);
    expect(out.join('\n')).toMatch(
      /pablo\.plataforma .*portal: active \(platform_admin\) .*keycloak: enabled/,
    );
  });

  it('disable [--reason] passes the reason on and prints what changed and the warnings', async () => {
    const { d, out } = deps();
    const code = await runDemoUsersCli(['disable', '--reason', 'Equipo propio con sus roles'], d);
    expect(code).toBe(0);
    expect(d.disable).toHaveBeenCalledWith('Equipo propio con sus roles');
    expect(out.join('\n')).toMatch(
      /pablo\.plataforma +portal: disabled, revoked platform_admin; keycloak: disabled/,
    );
    expect(out.join('\n')).toMatch(/warning: nobody holds auditor/);
  });

  it('a refusal exits 1 with the reason', async () => {
    const { d, err } = deps({
      disable: vi.fn(() => Promise.reject(new DemoUsersError('No active platform_admin'))),
    });
    expect(await runDemoUsersCli(['disable'], d)).toBe(1);
    expect(err.join('\n')).toMatch(/error: No active platform_admin/);
  });

  it('bad usage exits 2 with the usage', async () => {
    const { d, err } = deps();
    expect(await runDemoUsersCli([], d)).toBe(2);
    expect(await runDemoUsersCli(['disable', 'pablo.plataforma'], d)).toBe(2);
    expect(await runDemoUsersCli(['enable'], d)).toBe(2);
    expect(await runDemoUsersCli(['list', '--force'], d)).toBe(2);
    expect(err.join('\n')).toMatch(/usage: demo-users list/);
    expect(d.disable).not.toHaveBeenCalled();
  });

  it('other errors are not swallowed', async () => {
    const { d } = deps({ list: vi.fn(() => Promise.reject(new Error('database down'))) });
    await expect(runDemoUsersCli(['list'], d)).rejects.toThrow('database down');
  });
});
