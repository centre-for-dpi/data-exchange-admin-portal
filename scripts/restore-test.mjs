#!/usr/bin/env node
// `pnpm restore:test`: the backup and restore procedure of the Compose PostgreSQL, end to end
// (M6-06, ADR-0026), with the same image, pgBackRest configuration, scheduler and restore commands
// as the pilot (infra/postgres, install.sh restore, OPERATIONS.md §6). In throwaway containers and
// volumes of its own: the development stack is not touched.
//   1. PostgreSQL archiving its WAL to an encrypted repository; a full backup (den-backup-scheduler
//      --once); a row written before a point in time and another one after it.
//   2. Disaster: the data volume is lost. Restore the latest state into an empty volume: both rows
//      are there (the backup plus the archived WAL after it).
//   3. Point-in-time recovery in place (--delta) to the moment between the rows: only the first.
//   4. A full backup after the restore (new timeline) succeeds, and the repository is unreadable
//      without its key.
// Needs Docker. Exits 1 at the first expectation that does not hold.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'den/postgres:restore-test';
const RUN = `den-restore-test-${randomBytes(3).toString('hex')}`;
const VOLUMES = { data: `${RUN}-data`, repo: `${RUN}-repo`, socket: `${RUN}-socket` };
const ENV = {
  POSTGRES_USER: 'den',
  POSTGRES_PASSWORD: randomBytes(12).toString('hex'),
  POSTGRES_DB: 'den',
  PGBACKREST_PG1_USER: 'den',
  PGBACKREST_REPO1_CIPHER_PASS: randomBytes(24).toString('base64url'),
};
// The pilot's settings (docker-compose.deploy.yml).
const ARCHIVING = [
  '-c',
  'archive_mode=on',
  '-c',
  'archive_command=pgbackrest --stanza=den archive-push %p',
  '-c',
  'archive_timeout=60',
];

const log = (text) => console.log(text);
const ok = (text) => log(`   ✓ ${text}`);
class Failure extends Error {}

function docker(args, { allowFail = false, timeout = 300_000 } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (r.status !== 0 && !allowFail) {
    throw new Failure(`docker ${args.slice(0, 3).join(' ')} … failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}
const envArgs = () => Object.entries(ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
const mounts = () => [
  '-v',
  `${VOLUMES.data}:/var/lib/postgresql`,
  '-v',
  `${VOLUMES.repo}:/var/lib/pgbackrest`,
  '-v',
  `${VOLUMES.socket}:/var/run/postgresql`,
];
const DB = `${RUN}-db`;

function startDatabase() {
  docker(['run', '-d', '--name', DB, ...envArgs(), ...mounts(), IMAGE, 'postgres', ...ARCHIVING]);
  for (let i = 0; i < 90; i += 1) {
    // pg_isready alone answers during the entrypoint's temporary init server: wait for TCP too.
    const r = docker(['exec', DB, 'pg_isready', '-h', '127.0.0.1', '-U', 'den', '-d', 'den'], {
      allowFail: true,
    });
    if (r.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Failure(
    `PostgreSQL did not start:\n${docker(['logs', DB], { allowFail: true }).stderr}`,
  );
}
/** A clean shutdown, as `docker compose stop` does: pgBackRest refuses to restore over a running cluster. */
function stopDatabase() {
  docker(['stop', '-t', '60', DB]);
  docker(['rm', DB]);
}

/** One-off run of the `pgbackrest` service: the same volumes, as the postgres user. */
const pgbackrest = (...args) =>
  docker(['run', '--rm', '--user', 'postgres', ...envArgs(), ...mounts(), IMAGE, ...args]);

/** `install.sh restore [time]`, the same command: --delta, and the mkdir for a lost volume. */
function restore(target) {
  const time = target ? ` --type=time --target='${target}' --target-action=promote` : '';
  pgbackrest(
    'sh',
    '-c',
    `mkdir -p /var/lib/postgresql/18 && pgbackrest --stanza=den --delta${time} restore`,
  );
}

const sql = (query) =>
  docker([
    'exec',
    DB,
    'psql',
    '-U',
    'den',
    '-d',
    'den',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    query,
  ]).stdout.trim();

function expectRows(expected, when) {
  const rows = sql("SELECT string_agg(v, ',' ORDER BY v) FROM restore_probe");
  if (rows !== expected) throw new Failure(`${when}: expected rows "${expected}", found "${rows}"`);
  ok(`${when}: rows "${expected}"`);
}

function cleanup() {
  docker(['rm', '-f', DB], { allowFail: true });
  docker(['volume', 'rm', '-f', ...Object.values(VOLUMES)], { allowFail: true });
}

try {
  log('0. Image (infra/postgres)');
  docker(['build', '-q', '-t', IMAGE, resolve(root, 'infra/postgres')], { timeout: 600_000 });
  ok(IMAGE);

  log('1. Archiving, a full backup and two rows around a point in time');
  startDatabase();
  pgbackrest('den-backup-scheduler', '--once');
  ok('stanza created, archiving checked, full backup taken');
  sql('CREATE TABLE restore_probe (v text)');
  sql("INSERT INTO restore_probe VALUES ('before')");
  // pg_sleep keeps the target strictly between the two commits.
  sql('SELECT pg_sleep(1.5)');
  const target = sql(
    "SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'",
  );
  sql('SELECT pg_sleep(1.5)');
  sql("INSERT INTO restore_probe VALUES ('after')");
  // `check` switches the WAL segment and waits until it reaches the repository.
  pgbackrest('pgbackrest', '--stanza=den', 'check');
  ok(`target ${target}; the WAL with both rows is archived`);

  log('2. Disaster: the data volume is lost; restore the latest state into an empty one');
  stopDatabase();
  docker(['volume', 'rm', VOLUMES.data]);
  docker(['volume', 'create', VOLUMES.data]);
  restore();
  startDatabase();
  expectRows('after,before', 'latest restore');

  log('3. Point-in-time recovery in place, to the moment between the rows');
  stopDatabase();
  restore(target);
  startDatabase();
  expectRows('before', 'point-in-time restore');

  log('4. After the restore');
  pgbackrest('pgbackrest', '--stanza=den', '--type=full', 'backup');
  const info = JSON.parse(pgbackrest('pgbackrest', '--stanza=den', '--output=json', 'info').stdout);
  const backups = info[0]?.backup?.length ?? 0;
  if (backups < 2) throw new Failure(`expected two backups in the repository, found ${backups}`);
  ok(`a full backup on the new timeline (${backups} in the repository)`);
  const keyless = docker(
    [
      'run',
      '--rm',
      '--user',
      'postgres',
      '-e',
      'PGBACKREST_PG1_USER=den',
      ...mounts(),
      IMAGE,
      'pgbackrest',
      '--stanza=den',
      'info',
    ],
    { allowFail: true },
  );
  if (keyless.status === 0 || !/cipher|decrypt/i.test(keyless.stdout + keyless.stderr)) {
    throw new Failure(`the repository is readable without its key:
${keyless.stdout}`);
  }
  ok('the repository cannot be read without PGBACKREST_REPO1_CIPHER_PASS');

  log('\nRestore test passed.');
} catch (error) {
  console.error(`\n✗ ${error instanceof Failure ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
