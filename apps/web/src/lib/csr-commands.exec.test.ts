import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CsrShell, csrCommands } from './csr-commands';

/**
 * Runs the page's commands (P-05) with a real client ID and the system's OpenSSL, as a person
 * pasting them would: in CI on Linux (bash and openssl are there) and, on Windows, from Git Bash
 * and PowerShell. Skipped where they cannot run, e.g. `bash` resolving to WSL's launcher.
 */

const id = 'den-app-01a1efe4-c982-7e65-8855-7ea59c07bb55';
const keyExists = `${id}.key already exists: it is not overwritten.`;
const opensslMissing = 'OpenSSL was not found.';
const commands = (shell: CsrShell) =>
  csrCommands({ clientId: id, keyExists, opensslMissing }).find((c) => c.shell === shell)?.code ??
  '';

/** bash with openssl, and on Windows only Git Bash (MSYS), not WSL. */
const bashUsable = (() => {
  const r = spawnSync('bash', ['-c', 'uname -s && command -v openssl'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  return process.platform !== 'win32' || /^(MINGW|MSYS|CYGWIN)/.test(r.stdout);
})();

const powershellUsable =
  process.platform === 'win32' &&
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable'], {
    encoding: 'utf8',
  }).status === 0;

/** OpenSSL 3.0 (Ubuntu 24.04, the CI runner) writes "subject=CN = <id>", later ones no spaces. */
const subject = (output: string) => output.trim().replaceAll(' ', '');

const subjectOf = (file: string) =>
  subject(
    spawnSync('openssl', ['req', '-in', file, '-noout', '-subject'], { encoding: 'utf8' }).stdout,
  );

const keyText = (file: string) =>
  spawnSync('openssl', ['pkey', '-in', file, '-noout', '-text'], { encoding: 'utf8' }).stdout;

/** On Windows, the key's ACL: only the current user, nobody inherited or added. */
function expectOwnerOnlyAcl(file: string): void {
  const acl = spawnSync('icacls', [file], { encoding: 'utf8' }).stdout;
  const entries = acl.match(/:\([A-Z,()]+\)/g) ?? [];
  expect(entries, acl).toEqual([':(F)']);
  expect(acl).not.toMatch(/Everyone|BUILTIN|NT AUTHORITY|\(I\)/);
}

function bash(code: string, cwd: string, pathFirst?: string) {
  // Git Bash always sets USERNAME; a task runner may strip it (turbo's strict env mode).
  const env = { ...process.env, USERNAME: process.env.USERNAME || userInfo().username };
  if (pathFirst) env.PATH = `${pathFirst}${delimiter}${env.PATH ?? ''}`;
  return spawnSync('bash', [], { cwd, input: code, encoding: 'utf8', env });
}

describe.skipIf(!bashUsable)('the CSR commands, run (P-05)', () => {
  // The Linux/macOS commands are not for Git Bash: there MSYS mangles -subj (the bug P-05 fixes).
  const shells =
    process.platform === 'win32' ? (['gitBash'] as const) : (['posix', 'gitBash'] as const);
  for (const shell of shells) {
    it(`${shell}: makes a P-256 key readable only by its owner and a CSR for CN=<client id>, never overwriting`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'den-csr-page-'));
      const first = bash(commands(shell), dir);
      expect(first.status, first.stderr).toBe(0);
      // The last command shows what the page says to check before pasting.
      expect(subject(first.stdout)).toBe(`subject=CN=${id}`);
      expect(subjectOf(join(dir, `${id}.csr`))).toBe(`subject=CN=${id}`);
      const key = readFileSync(join(dir, `${id}.key`), 'utf8');
      expect(key).toMatch(/BEGIN PRIVATE KEY/);
      expect(keyText(join(dir, `${id}.key`))).toMatch(/prime256v1|P-256/);
      if (process.platform === 'win32') {
        if (shell === 'gitBash') expectOwnerOnlyAcl(join(dir, `${id}.key`));
      } else {
        expect(statSync(join(dir, `${id}.key`)).mode & 0o777).toBe(0o600);
      }

      const second = bash(commands(shell), dir);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain(keyExists);
      expect(readFileSync(join(dir, `${id}.key`), 'utf8')).toBe(key);
    });

    it(`${shell}: leaves no half-made key behind when OpenSSL fails`, () => {
      const fake = mkdtempSync(join(tmpdir(), 'den-fake-openssl-'));
      const bin = join(fake, 'openssl');
      writeFileSync(
        bin,
        '#!/usr/bin/env bash\necho partial > "${@: -5:1}"\necho "req: subject name is expected to be in the format /type0=value0" >&2\nexit 1\n',
      );
      chmodSync(bin, 0o755);
      const dir = mkdtempSync(join(tmpdir(), 'den-csr-page-fail-'));
      const r = bash(commands(shell), dir, fake);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/subject name is expected/);
      expect(existsSync(join(dir, `${id}.key`))).toBe(false);
      expect(existsSync(join(dir, `${id}.csr`))).toBe(false);
    });
  }
});

describe.skipIf(!powershellUsable)('the PowerShell CSR commands, run (P-05)', () => {
  const run = (dir: string) => {
    const script = join(mkdtempSync(join(tmpdir(), 'den-csr-ps1-')), 'csr.ps1');
    // UTF-8 with BOM: Windows PowerShell 5.1 reads a file without one in the ANSI code page.
    writeFileSync(script, `${String.fromCharCode(0xfeff)}${commands('powershell')}\n`);
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd: dir, encoding: 'utf8' },
    );
  };

  it('makes the key with an ACL for the current user only and refuses to overwrite it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-csr-page-ps-'));
    const first = run(dir);
    expect(first.status, first.stderr).toBe(0);
    expect(subject(first.stdout)).toBe(`subject=CN=${id}`);
    const key = readFileSync(join(dir, `${id}.key`), 'utf8');
    expect(key).toMatch(/BEGIN PRIVATE KEY/);
    expectOwnerOnlyAcl(join(dir, `${id}.key`));

    const second = run(dir);
    expect(second.status).not.toBe(0);
    // Windows PowerShell wraps its error output at the console's width.
    expect(second.stderr.replace(/\s+/g, ' ')).toContain(keyExists);
    expect(readFileSync(join(dir, `${id}.key`), 'utf8')).toBe(key);
  });
});
