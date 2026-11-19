import { describe, expect, it } from 'vitest';
import { csrCommands, csrScriptCommand, powershellString } from './csr-commands';

const id = 'den-app-01a1efe4-c982-7e65-8855-7ea59c07bb55';
const input = {
  clientId: id,
  keyExists: `${id}.key already exists: it is not overwritten.`,
  opensslMissing: 'OpenSSL was not found.',
};
const code = (shell: string) => csrCommands(input).find((c) => c.shell === shell)?.code ?? '';

describe('CSR commands per shell (P-05)', () => {
  it('Linux and macOS: umask 077, no overwrite, no half-made key, then the subject check', () => {
    expect(code('posix').split('\n')).toEqual([
      '(',
      `  id=${id}`,
      '  umask 077',
      `  if [ -e "$id.key" ]; then echo '${id}.key already exists: it is not overwritten.' >&2; exit 1; fi`,
      '  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \\',
      '    -keyout "$id.key" -out "$id.csr" -subj "/CN=$id" || { rm -f "$id.key" "$id.csr"; exit 1; }',
      '  openssl req -in "$id.csr" -noout -subject',
      ')',
    ]);
  });

  it('Git Bash: the same with MSYS_NO_PATHCONV=1, and the key left to its owner with icacls', () => {
    const lines = code('gitBash').split('\n');
    expect(lines[4]).toBe(
      '  MSYS_NO_PATHCONV=1 openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \\',
    );
    expect(lines[6]).toBe(
      '  if [ -n "$USERNAME" ] && command -v icacls >/dev/null; then MSYS_NO_PATHCONV=1 icacls "$id.key" /inheritance:r /grant:r "$USERNAME:F" >/dev/null; fi',
    );
    // Everything else as on Linux.
    expect(lines.filter((_, i) => i !== 4 && i !== 6)).toEqual(
      code('posix')
        .split('\n')
        .filter((_, i) => i !== 4),
    );
  });

  it('PowerShell: finds OpenSSL, restricts the file before the key is written, refuses to overwrite', () => {
    expect(code('powershell').split('\n')).toEqual([
      '& {',
      `  $id = '${id}'`,
      '  $key = "$id.key"; $csr = "$id.csr"',
      `  if (Test-Path -LiteralPath $key) { throw '${id}.key already exists: it is not overwritten.' }`,
      '  $git = "$env:ProgramFiles\\Git"',
      '  $openssl = Get-Command openssl, "$git\\usr\\bin\\openssl.exe", "$git\\mingw64\\bin\\openssl.exe" -CommandType Application -ErrorAction Ignore | Select-Object -First 1',
      "  if (-not $openssl) { throw 'OpenSSL was not found.' }",
      '  New-Item -ItemType File -Path $key | Out-Null',
      '  icacls $key /inheritance:r /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):F" | Out-Null',
      '  if ($LASTEXITCODE -eq 0) { & $openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout $key -out $csr -subj "/CN=$id" }',
      '  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $key, $csr -ErrorAction Ignore; return }',
      '  & $openssl req -in $csr -noout -subject',
      '}',
    ]);
  });

  it('quotes the messages for each shell, whatever the language puts in them', () => {
    const tricky = csrCommands({
      ...input,
      keyExists: `it's "${id}.key" $HOME \`x\``,
      opensslMissing: "no se encontró 'openssl' $env:PATH",
    });
    expect(tricky[0]?.code).toContain(`echo 'it'\\''s "${id}.key" $HOME \`x\`' >&2`);
    expect(tricky[2]?.code).toContain(`throw 'it''s "${id}.key" $HOME \`x\`'`);
    expect(tricky[2]?.code).toContain("throw 'no se encontró ''openssl'' $env:PATH'");
    expect(powershellString("a'b")).toBe("'a''b'");
  });

  it('accepts only client IDs as entity-check.sh does, so nothing can change the command', () => {
    for (const bad of ['', 'den app', 'x;rm -rf ~', "x'y", 'x$(id)', 'a/b', 'x\ny']) {
      expect(() => csrCommands({ ...input, clientId: bad }), bad).toThrow();
    }
  });

  it('runs the downloaded script with the same client ID', () => {
    expect(csrScriptCommand(id)).toBe(`bash entity-check.sh csr ${id}`);
  });
});
