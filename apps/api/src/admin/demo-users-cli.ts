// `pnpm demo-users <list|disable> ...`; in a pilot, `./install.sh demo-users ...` or
// `node dist/admin/demo-users-cli.js ...` inside the api container. Disables the seed's demo users
// once the operator's own people have their platform roles, audited (demo-users.ts, P-08).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AuditService } from '../audit/audit.service.js';
import { loadDevEnv } from '../dev-env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import {
  type DemoUserState,
  type DisableDemoUsersResult,
  DemoUsersError,
  disableDemoUsers,
  listDemoUsers,
} from './demo-users.js';
import { HttpKeycloakUsers } from './keycloak-users.js';

const USAGE = [
  'usage: demo-users list',
  '       demo-users disable [--reason "<why>"]',
  'disable: the demo users can no longer sign in (Keycloak) and lose their platform roles in the',
  'portal; the seed leaves them disabled. It needs an active platform_admin of your own first.',
].join('\n');

export interface DemoUsersCliDeps {
  list: () => Promise<DemoUserState[]>;
  disable: (reason?: string) => Promise<DisableDemoUsersResult>;
  print: (line: string) => void;
  printError: (line: string) => void;
}

/** Runs one command; returns the process exit code (0 done, 1 refused, 2 bad usage). */
export async function runDemoUsersCli(argv: string[], deps: DemoUsersCliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { reason: { type: 'string' } },
    });
  } catch (error) {
    deps.printError(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, ...extra] = parsed.positionals;
  try {
    if (command === 'list' && extra.length === 0) {
      for (const u of await deps.list()) {
        const roles = u.platformRoles.length > 0 ? ` (${u.platformRoles.join(', ')})` : '';
        deps.print(
          `${u.username.padEnd(18)} ${u.email.padEnd(36)} portal: ${`${u.portal}${roles}`.padEnd(28)} keycloak: ${u.keycloak}`,
        );
      }
      return 0;
    }
    if (command === 'disable' && extra.length === 0) {
      const result = await deps.disable(parsed.values.reason);
      for (const u of result.users) {
        const roles = u.rolesRevoked.length > 0 ? `, revoked ${u.rolesRevoked.join(', ')}` : '';
        deps.print(
          `${u.username.padEnd(18)} portal: ${u.portal.replace('_', ' ')}${roles}; keycloak: ${u.keycloak}`,
        );
      }
      for (const warning of result.warnings) deps.print(`warning: ${warning}`);
      return 0;
    }
    deps.printError(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof DemoUsersError) {
      deps.printError(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  loadDevEnv();
  const prisma = new PrismaService();
  const audit = new AuditService();
  const keycloak = HttpKeycloakUsers.fromEnv();
  const personas = readRealmUsers();
  try {
    process.exitCode = await runDemoUsersCli(process.argv.slice(2), {
      list: () => listDemoUsers(prisma, personas, keycloak),
      disable: (reason) => {
        if (!keycloak) {
          throw new DemoUsersError(
            'KEYCLOAK_ADMIN_USER and KEYCLOAK_ADMIN_PASSWORD must be set: without them the demo ' +
              'users could still sign in',
          );
        }
        return disableDemoUsers(prisma, audit, keycloak, { personas, reason });
      },
      print: (line) => process.stdout.write(`${line}\n`),
      printError: (line) => console.error(line),
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
