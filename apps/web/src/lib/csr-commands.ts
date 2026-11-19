import { shellWord } from './kit-install';

/**
 * The commands that make an application's private key and certificate signing request on its own
 * server (M3-01, P-05), one set per shell. They do what `scripts/entity-check.sh csr` does: an
 * ECDSA P-256 key in `<client id>.key`, readable only by its owner, never overwritten, and a CSR
 * in `<client id>.csr` whose subject is `CN=<client id>`; a failed OpenSSL leaves no half-made key
 * behind, and the last command shows the subject to check before pasting the CSR.
 *
 * The key is born where it is used and never travels: the portal does not offer to make it in the
 * browser, where it would land on someone's laptop and be exposed to any flaw in the portal.
 */

export const CSR_SHELLS = ['posix', 'gitBash', 'powershell'] as const;
export type CsrShell = (typeof CSR_SHELLS)[number];

/** The client IDs the portal makes (`den-app-<uuid>`), as `entity-check.sh` accepts them. */
const CLIENT_ID = /^[A-Za-z0-9._-]+$/;

export interface CsrCommandsInput {
  clientId: string;
  /** Said when `<client id>.key` already exists, in the page's language. */
  keyExists: string;
  /** Said in PowerShell when no OpenSSL is found. */
  opensslMissing: string;
}

export interface CsrCommands {
  shell: CsrShell;
  code: string;
}

/** A PowerShell literal: single quotes, with any single quote doubled. */
export const powershellString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A POSIX shell literal in single quotes, whatever it holds. */
const posixString = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** The key and request `entity-check.sh csr` makes: ECDSA P-256, unencrypted (it stays put). */
const REQ_NEW = 'req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes';

/**
 * Linux and macOS, and Git Bash on Windows. A subshell, so that `umask 077`, the variable and an
 * early `exit` stay in it when pasted. Git Bash (MSYS) turns `/CN=...` into a Windows path before
 * OpenSSL sees it unless MSYS_NO_PATHCONV is set; there umask does not reach the file's ACL, so
 * icacls leaves the key to its owner (guarded: elsewhere the variable and that line do nothing).
 */
function posix(clientId: string, keyExists: string, gitBash: boolean): string {
  const msys = gitBash ? 'MSYS_NO_PATHCONV=1 ' : '';
  return [
    '(',
    `  id=${shellWord(clientId)}`,
    '  umask 077',
    `  if [ -e "$id.key" ]; then echo ${posixString(keyExists)} >&2; exit 1; fi`,
    `  ${msys}openssl ${REQ_NEW} \\`,
    '    -keyout "$id.key" -out "$id.csr" -subj "/CN=$id" || { rm -f "$id.key" "$id.csr"; exit 1; }',
    ...(gitBash
      ? [
          `  if command -v icacls >/dev/null; then ${msys}icacls "$id.key" /inheritance:r /grant:r "$USERNAME:F" >/dev/null; fi`,
        ]
      : []),
    '  openssl req -in "$id.csr" -noout -subject',
    ')',
  ].join('\n');
}

/**
 * Windows PowerShell 5.1 and PowerShell 7. A script block, so that `throw` and `return` stop it
 * when pasted without closing the window. OpenSSL is the one on PATH or one Git for Windows
 * installs. The key file is created first, with an ACL for the current user alone (what umask 077
 * does), so OpenSSL writes the key into a file nobody else can read.
 */
function powershell(clientId: string, keyExists: string, opensslMissing: string): string {
  return [
    '& {',
    `  $id = ${powershellString(clientId)}`,
    '  $key = "$id.key"; $csr = "$id.csr"',
    `  if (Test-Path -LiteralPath $key) { throw ${powershellString(keyExists)} }`,
    '  $git = "$env:ProgramFiles\\Git"',
    '  $openssl = Get-Command openssl, "$git\\usr\\bin\\openssl.exe", "$git\\mingw64\\bin\\openssl.exe" -CommandType Application -ErrorAction Ignore | Select-Object -First 1',
    `  if (-not $openssl) { throw ${powershellString(opensslMissing)} }`,
    '  New-Item -ItemType File -Path $key | Out-Null',
    '  icacls $key /inheritance:r /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):F" | Out-Null',
    `  if ($LASTEXITCODE -eq 0) { & $openssl ${REQ_NEW} -keyout $key -out $csr -subj "/CN=$id" }`,
    '  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $key, $csr -ErrorAction Ignore; return }',
    '  & $openssl req -in $csr -noout -subject',
    '}',
  ].join('\n');
}

/** The commands for each shell, in the order of the page's tabs. */
export function csrCommands({
  clientId,
  keyExists,
  opensslMissing,
}: CsrCommandsInput): CsrCommands[] {
  if (!CLIENT_ID.test(clientId)) {
    throw new Error('A client ID has only A-Z, a-z, 0-9, ".", "_" and "-"');
  }
  return [
    { shell: 'posix', code: posix(clientId, keyExists, false) },
    { shell: 'gitBash', code: posix(clientId, keyExists, true) },
    { shell: 'powershell', code: powershell(clientId, keyExists, opensslMissing) },
  ];
}

/** What to run after downloading the script: it does the same and says what went wrong. */
export const csrScriptCommand = (clientId: string) =>
  `bash entity-check.sh csr ${shellWord(clientId)}`;

/** Where the web serves `scripts/entity-check.sh` (apps/web/src/app/files/entity-check.sh). */
export const ENTITY_CHECK_PATH = '/files/entity-check.sh';
