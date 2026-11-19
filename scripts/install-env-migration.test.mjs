// install.sh carries a .env from before the citizen-app rename (commit 9de1423) over to the new
// variable names (R-10): the functions run as written in install.sh, on a temporary .env.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installer = readFileSync(resolve(import.meta.dirname, '../install.sh'), 'utf8');
/** The body of a top-level function of install.sh, `name() { ... }` up to the closing brace. */
const fn = (name) => {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(installer);
  if (!match) throw new Error(`${name} not found in install.sh`);
  return match[0];
};
const harness = [
  'set -euo pipefail',
  'info() { :; }',
  fn('env_get'),
  fn('env_set'),
  fn('migrate_citizen_app_env'),
  'migrate_citizen_app_env',
].join('\n');

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs the migration on a .env with these lines and returns the resulting file. */
function migrate(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'den-env-'));
  dirs.push(dir);
  const envFile = join(dir, '.env');
  writeFileSync(envFile, `${lines.join('\n')}\n`);
  const r = spawnSync('bash', ['-c', harness], {
    env: { ...process.env, ENV_FILE: envFile },
    encoding: 'utf8',
  });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return readFileSync(envFile, 'utf8');
}

const pilotBefore = [
  'DEN_CARPETA_CLIENT_SECRET=s3cr3t-of-the-client',
  'DEN_CARPETA_URL=https://portal.den.example/carpeta',
  'DEN_CITIZEN_CLIENTS=carpeta-ciudadana',
  `DEN_CITIZEN_APPS='{"carpeta-ciudadana":{"webhookUrl":"http://carpeta:3100/carpeta/api/den/alerts","webhookSecret":"whsec_ab/c+d="}}'`,
];

// Each bash run forks a few subshells: slow on Windows.
describe('install.sh: a .env from before the citizen-app rename', { timeout: 30_000 }, () => {
  it('gets the new names with the same values, and the new client id and path', () => {
    const env = migrate(pilotBefore);
    expect(env).toContain('\nDEN_CITIZEN_APP_CLIENT_SECRET=s3cr3t-of-the-client\n');
    expect(env).toContain('\nDEN_CITIZEN_APP_URL=https://portal.den.example/citizen-app\n');
    expect(env).toContain('\nDEN_CITIZEN_CLIENTS=citizen-app\n');
    expect(env).toContain(
      `\nDEN_CITIZEN_APPS='{"citizen-app":{"webhookUrl":"http://citizen-app:3100/citizen-app/api/den/alerts","webhookSecret":"whsec_ab/c+d="}}'\n`,
    );
  });

  it('is idempotent', () => {
    const once = migrate(pilotBefore);
    expect(migrate(once.trimEnd().split('\n'))).toBe(once);
  });

  it('keeps a development URL without the old path, and other client ids', () => {
    const env = migrate([
      'DEN_CARPETA_URL=http://localhost:3100',
      'DEN_CITIZEN_CLIENTS=other-app,carpeta-ciudadana',
    ]);
    expect(env).toContain('\nDEN_CITIZEN_APP_URL=http://localhost:3100\n');
    expect(env).toContain('\nDEN_CITIZEN_CLIENTS=other-app,citizen-app\n');
  });

  it('leaves a .env with the new names alone', () => {
    const current = [
      'DEN_CITIZEN_APP_CLIENT_SECRET=new',
      'DEN_CITIZEN_APP_URL=https://portal.den.example/citizen-app',
      'DEN_CITIZEN_CLIENTS=citizen-app',
      'DEN_CARPETA_CLIENT_SECRET=old',
    ];
    expect(migrate(current)).toBe(`${current.join('\n')}\n`);
  });
});
