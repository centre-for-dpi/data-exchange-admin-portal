import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, 'entity-check.sh');

/** Runs `entity-check.sh csr <id>` in a fresh directory, optionally with extra PATH entries first. */
function csr(id, { pathFirst } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'den-csr-'));
  const env = { ...process.env };
  if (pathFirst) env.PATH = `${pathFirst}${delimiter}${env.PATH}`;
  const result = spawnSync('bash', [script, 'csr', id], { cwd: dir, encoding: 'utf8', env });
  return { ...result, dir };
}

// OpenSSL 3.0 (Ubuntu 24.04, the CI runner) writes "subject=CN = <id>", later ones no spaces.
const subjectOf = (file) =>
  spawnSync('openssl', ['req', '-in', file, '-noout', '-subject'], {
    encoding: 'utf8',
  })
    .stdout.trim()
    .replaceAll(' ', '');

/** A stand-in openssl that answers -subject as OpenSSL 3.0 does and passes the rest on. */
function openssl30() {
  const real = spawnSync('bash', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'den-openssl30-'));
  const bin = join(dir, 'openssl');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      'if [[ " $* " == *" -subject "* ]]; then',
      `  out=$('${real}' "$@") || exit`,
      '  printf \'%s\\n\' "${out/subject=CN=/subject=CN = }"',
      '  exit',
      'fi',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return dir;
}

describe('entity-check.sh csr', () => {
  const id = 'den-app-01a1efe4-c982-7e65-8855-7ea59c07bb55';

  it('makes the key and a CSR naming exactly the client id, also from Git Bash on Windows', () => {
    const r = csr(id);
    expect(r.status, r.stderr).toBe(0);
    expect(subjectOf(join(r.dir, `${id}.csr`))).toBe(`subject=CN=${id}`);
    expect(readFileSync(join(r.dir, `${id}.key`), 'utf8')).toMatch(/BEGIN PRIVATE KEY/);
    if (process.platform !== 'win32') {
      expect(statSync(join(r.dir, `${id}.key`)).mode & 0o777).toBe(0o600);
    }
  });

  it('accepts the subject as OpenSSL 3.0 writes it (Debian 12, Ubuntu 22.04 and 24.04)', () => {
    const r = csr(id, { pathFirst: openssl30() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Solicitud de certificado/);
    expect(readFileSync(join(r.dir, `${id}.key`), 'utf8')).toMatch(/BEGIN PRIVATE KEY/);
    expect(subjectOf(join(r.dir, `${id}.csr`))).toBe(`subject=CN=${id}`);
  });

  it('leaves no half-made key behind and says why when OpenSSL fails', () => {
    // A stand-in openssl that fails the way a rejected subject does.
    const fake = mkdtempSync(join(tmpdir(), 'den-fake-openssl-'));
    const bin = join(fake, 'openssl');
    writeFileSync(
      bin,
      '#!/usr/bin/env bash\necho "req: subject name is expected to be in the format /type0=value0" >&2\nexit 1\n',
    );
    chmodSync(bin, 0o755);
    const r = csr(id, { pathFirst: fake });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/subject name is expected/);
    expect(existsSync(join(r.dir, `${id}.key`))).toBe(false);
    expect(existsSync(join(r.dir, `${id}.csr`))).toBe(false);
  });

  it('check does not stop at the DNS step where getent is missing (Git Bash on Windows)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-check-'));
    const r = spawnSync('bash', [script, 'check', '127.0.0.1', '127.0.0.1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/no resuelve/);
    expect(r.stderr).toMatch(/No llego a https:\/\/127\.0\.0\.1/);
  });

  it('call accepts the certificate as the portal downloads it (<client id>.pem)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-call-'));
    for (const f of [`${id}.key`, `${id}.pem`, 'den-network-ca.pem'])
      writeFileSync(join(dir, f), 'x');
    const r = spawnSync(
      'bash',
      [script, 'call', '127.0.0.1', '127.0.0.1:9', id, '/x/y/v1/z/1', 'eligibility_check', 'u-1'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, CLIENT_SECRET: 'secret' } },
    );
    expect(r.stderr).not.toMatch(/Faltan/);
    expect(r.stderr).toMatch(/No se pudo pedir el token/);
  });

  it('call goes through OpenSSL when curl is Schannel-only (Git for Windows), not through curl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-call-schannel-'));
    for (const f of [`${id}.key`, `${id}.pem`, 'den-network-ca.pem'])
      writeFileSync(join(dir, f), 'x');
    // A stand-in curl that reports a Schannel-only build and fails like it does with a PEM key.
    const fake = mkdtempSync(join(tmpdir(), 'den-fake-curl-'));
    const bin = join(fake, 'curl');
    writeFileSync(
      bin,
      '#!/usr/bin/env bash\nif [[ $1 == -V ]]; then echo "curl 8.18.0 (x86_64-w64-mingw32) libcurl/8.18.0 Schannel zlib/1.3"; exit 0; fi\necho "CURL_USED_FOR_REQUEST" >&2\nexit 58\n',
    );
    chmodSync(bin, 0o755);
    const r = spawnSync(
      'bash',
      [script, 'call', '127.0.0.1', '127.0.0.1:9', id, '/x/y/v1/z/1', 'eligibility_check'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLIENT_SECRET: 'secret',
          PATH: `${fake}${delimiter}${process.env.PATH}`,
        },
      },
    );
    expect(r.stderr).not.toMatch(/CURL_USED_FOR_REQUEST/);
    expect(r.stderr).toMatch(/No se pudo pedir el token/);
  });

  it('refuses a client id with characters that could change the command', () => {
    const r = csr('den-app; rm -rf /');
    expect(r.status).not.toBe(0);
  });
});
