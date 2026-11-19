// install.sh on a pilot's .env (R-04): the functions run as written in install.sh, on a temporary
// .env and backups folder, with docker stubbed out.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const installer = readFileSync(join(root, 'install.sh'), 'utf8');
/** The body of a top-level function of install.sh, `name() { ... }` up to the closing brace. */
const fn = (name) => {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(installer);
  if (!match) throw new Error(`${name} not found in install.sh`);
  return match[0];
};
const oneLiner = (name) => {
  const match = new RegExp(`^${name}\\(\\) \\{ .* \\}$`, 'm').exec(installer);
  if (!match) throw new Error(`${name} not found in install.sh`);
  return match[0];
};
const constant = (name) => {
  const match = new RegExp(`^${name}=\\([\\s\\S]*?\\)$`, 'm').exec(installer);
  if (!match) throw new Error(`${name} not found in install.sh`);
  return match[0];
};

const harness = (body) =>
  [
    'set -euo pipefail',
    `ROOT=${JSON.stringify(process.env.R04_ROOT ?? '')}`,
    'info() { printf "info: %s\\n" "$*"; }',
    'warn() { printf "warn: %s\\n" "$*"; }',
    'ok() { :; }',
    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    // No Docker here: no proxy container to find.
    'docker() { return 1; }',
    constant('EXAMPLE_SECRETS'),
    fn('env_get'),
    fn('env_set'),
    fn('env_quote'),
    oneLiner('example_value'),
    oneLiner('random_secret'),
    fn('ensure_r04_env'),
    fn('ensure_trust_proxy'),
    fn('external_proxy'),
    fn('check_example_secrets'),
    fn('prune_backups'),
    fn('admin_sources'),
    fn('render_edge'),
    body,
  ].join('\n');

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs `body` with ENV_FILE holding these lines; returns the output and the resulting file. */
function run(lines, body, { work } = {}) {
  const dir = work ?? mkdtempSync(join(tmpdir(), 'den-r04-'));
  if (!work) dirs.push(dir);
  const envFile = join(dir, '.env');
  writeFileSync(envFile, `${lines.join('\n')}\n`);
  // ROOT is the repository (its .env.example) unless the test gives a folder of its own.
  const script = harness(body).replace(/^ROOT=.*$/m, `ROOT=${JSON.stringify(work ?? root)}`);
  const r = spawnSync('bash', ['-c', script], {
    env: { ...process.env, ENV_FILE: envFile },
    encoding: 'utf8',
  });
  return { ...r, env: readFileSync(envFile, 'utf8') };
}
const valueIn = (env, name) =>
  (env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? '').replace(/^'(.*)'$/, '$1');

const pilotBefore = [
  'STEP_CA_PASSWORD=ca-secret-of-the-pilot',
  'DEN_STEP_CA_PROVISIONER_PASSWORD=ca-secret-of-the-pilot',
  'DEN_DEMO_USER_PASSWORD=shared-demo-password',
  'DEN_SMTP_URL=smtp://127.0.0.1:1025',
  'DEN_INSTALL_PROXY=bundled',
  'TRAEFIK_NETWORK=den-edge',
  'DEN_TRUST_PROXY=',
];

// Each bash run forks a few subshells: slow on Windows.
describe('install.sh: R-04 on an existing pilot', { timeout: 30_000 }, () => {
  it('adds what R-04 needs, keeps the rest, and is idempotent', () => {
    const once = run(pilotBefore, 'ensure_r04_env');
    expect(once.stderr).toBe('');
    expect(once.status).toBe(0);
    const env = once.env;
    // B-16: the provisioners' passwords are no longer the CA's.
    const provisioners = [
      'DEN_STEP_CA_PROVISIONER_PASSWORD',
      'DEN_STEP_CA_GATEWAY_PROVISIONER_PASSWORD',
      'DEN_STEP_CA_NODE_PROVISIONER_PASSWORD',
    ].map((n) => valueIn(env, n));
    expect(provisioners.every((p) => p.length >= 24 && p !== 'ca-secret-of-the-pilot')).toBe(true);
    expect(valueIn(env, 'STEP_CA_PASSWORD')).toBe('ca-secret-of-the-pilot');
    // M-29: a password apart for the critical roles, applied by `realms`.
    expect(valueIn(env, 'DEN_DEMO_CRITICAL_PASSWORD')).not.toBe('shared-demo-password');
    expect(valueIn(env, 'DEN_DEMO_CRITICAL_PENDING')).toBe('true');
    // M-28, B-28, M-27.
    expect(valueIn(env, 'DEN_SMTP_URL')).toBe('smtp://mailpit:1025');
    expect(valueIn(env, 'DEN_KEYCLOAK_ADMIN_URL')).toBe('http://keycloak:8080/auth');
    expect(valueIn(env, 'DEN_TRUST_PROXY')).toBe('edge,web');
    expect(valueIn(env, 'DEN_WEB_PROXY_TOKEN')).toMatch(/^[A-Za-z0-9]{32,}$/);

    const twice = run(env.trimEnd().split('\n'), 'ensure_r04_env');
    expect(twice.env).toBe(env);
  });

  it("keeps the operator's SMTP server, and adds web to the proxy's address", () => {
    const { env } = run(
      [
        'DEN_SMTP_URL=smtps://user:pw@smtp.example.org:465',
        'DEN_INSTALL_PROXY=external',
        'DEN_TRUST_PROXY=172.20.0.2',
      ],
      'ensure_r04_env',
    );
    expect(valueIn(env, 'DEN_SMTP_URL')).toBe('smtps://user:pw@smtp.example.org:465');
    expect(valueIn(env, 'DEN_TRUST_PROXY')).toBe('172.20.0.2,web');
  });

  it('with an external proxy it cannot find, trusts the web only and says so', () => {
    const r = run(['DEN_INSTALL_PROXY=external', 'TRAEFIK_NETWORK=proxy'], 'ensure_trust_proxy');
    expect(valueIn(r.env, 'DEN_TRUST_PROXY')).toBe('web');
    expect(r.stdout).toContain('DEN_TRUST_PROXY');
  });
});

describe('install.sh: .env values (B-30) and example secrets (M-25)', { timeout: 30_000 }, () => {
  it('writes any value as is, and quotes what Compose, bash and Node must read literally', () => {
    const r = run(
      ['A=old'],
      [
        `env_set A 'back\\slash and $dollar'`,
        `env_set B "$(env_quote 'pa$$word#and spaces')"`,
        `if env_quote "it's" >/dev/null; then echo QUOTED; fi`,
        `printf 'B=[%s]\\n' "$(env_get B)"`,
      ].join('\n'),
    );
    expect(r.status).toBe(0);
    expect(r.env).toContain('\nA=back\\slash and $dollar\n'.slice(1));
    expect(r.env).toContain("B='pa$$word#and spaces'");
    expect(r.stdout).not.toContain('QUOTED');
    expect(r.stdout).toContain('B=[pa$$word#and spaces]');
    // What bash itself reads from that line.
    const sourced = spawnSync(
      'bash',
      ['-c', `set -a; . "$1"; printf '%s' "$B"`, 'x', join(dirs[0], '.env')],
      {
        encoding: 'utf8',
      },
    );
    expect(sourced.stdout).toBe('pa$$word#and spaces');
  });

  it('refuses a .env with a secret of .env.example', () => {
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    const postgres = /^POSTGRES_PASSWORD=(.*)$/m.exec(example)[1];
    const r = run(
      [`POSTGRES_PASSWORD=${postgres}`, 'AUTH_SECRET=generated-elsewhere'],
      'check_example_secrets',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('POSTGRES_PASSWORD');
    expect(r.stderr).not.toContain('AUTH_SECRET');
    expect(run(['POSTGRES_PASSWORD=generated'], 'check_example_secrets').status).toBe(0);
  });

  it('every secret it checks exists in .env.example', () => {
    const names = constant('EXAMPLE_SECRETS')
      .replace(/^EXAMPLE_SECRETS=\(|\)$/g, '')
      .split(/\s+/)
      .filter(Boolean);
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    for (const name of names) expect(example, name).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
  });
});

describe('install.sh: backups and the edge', { timeout: 30_000 }, () => {
  it('keeps the newest DEN_BACKUP_KEEP backups and nothing else is touched (M-24)', () => {
    const work = mkdtempSync(join(tmpdir(), 'den-r04-'));
    dirs.push(work);
    const names = ['20261101-020000', '20261102-020000', '20261103-020000', '20261104-020000'];
    for (const name of [...names, 'keep-me'])
      mkdirSync(join(work, 'backups', name), { recursive: true });
    const r = run(['DEN_BACKUP_KEEP=2'], 'prune_backups', { work });
    expect(r.status).toBe(0);
    expect(readdirSync(join(work, 'backups')).sort()).toEqual([
      '20261103-020000',
      '20261104-020000',
      'keep-me',
    ]);
  });

  it("renders Keycloak's administration allow-list, closed by default (B-28)", () => {
    const r = run(
      [],
      [
        `printf '[%s]\\n' "$(admin_sources '')"`,
        `printf '[%s]\\n' "$(admin_sources '203.0.113.10, 198.51.100.0/24')"`,
        `if admin_sources 'evil.example' >/dev/null; then echo ACCEPTED; fi`,
      ].join('\n'),
    );
    expect(r.stdout).toContain("['127.0.0.1/32']");
    expect(r.stdout).toContain("['203.0.113.10','198.51.100.0/24']");
    expect(r.stdout).not.toContain('ACCEPTED');
  });
});

describe('install.sh: the proxy proves itself to the web (M-27)', { timeout: 30_000 }, () => {
  it("writes the token into the web's route, readable by its owner only", () => {
    const work = mkdtempSync(join(tmpdir(), 'den-r04-'));
    dirs.push(work);
    mkdirSync(join(work, 'infra/edge'), { recursive: true });
    writeFileSync(
      join(work, 'infra/edge/den.yml.template'),
      readFileSync(join(root, 'infra/edge/den.yml.template')),
    );
    const token = 'a'.repeat(20) + 'B_c-'.repeat(4);
    const r = run(
      [`DEN_WEB_PROXY_TOKEN=${token}`],
      [
        'cd "$ROOT"',
        'PORTAL_HOST=portal.den.example GATEWAY_HOST=gw.den.example',
        "render_edge websecure '{}' out.yml",
        'stat -c %a out.yml 2>/dev/null || true',
      ].join('\n'),
      { work },
    );
    expect(r.stderr).toBe('');
    // Git Bash on Windows has no Unix modes.
    if (process.platform !== 'win32') expect(r.stdout.trim()).toBe('600');
    const routes = readFileSync(join(work, 'out.yml'), 'utf8');
    expect(routes).toContain(`X-DEN-Proxy-Token: '${token}'`);
    expect(routes).toMatch(/service: den-web\n\s+middlewares: \[den-web-from-proxy\]/);
    expect(routes).not.toMatch(/@[A-Z_]+@/);
  });

  it('refuses to write routes without a usable token', () => {
    const r = run(['DEN_WEB_PROXY_TOKEN=short'], "render_edge websecure '{}' /dev/null");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DEN_WEB_PROXY_TOKEN');
  });
});

describe('install.sh: update on a pilot whose .env lacks the new variables', () => {
  // The first update of an older pilot runs the previous installer and stops at Compose, asking
  // for a variable; the second runs this one, whose backup also starts Compose. The variables must
  // be there before it.
  it('adds the .env variables before the backup', () => {
    const body = fn('cmd_update');
    expect(body.indexOf('ensure_env_additions')).toBeGreaterThan(-1);
    expect(body.indexOf('ensure_env_additions')).toBeLessThan(body.indexOf('cmd_backup'));
  });
});
