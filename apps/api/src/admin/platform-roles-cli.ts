// `pnpm platform-roles <grant|revoke|list> ...`; in a deployment, `./install.sh platform-role ...`
// or `node dist/admin/platform-roles-cli.js ...` inside the api container. Gives the operator's own
// people the platform roles no screen grants yet, audited (platform-roles.ts).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PLATFORM_ROLES } from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import { loadDevEnv } from '../dev-env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  grantPlatformRole,
  listPlatformRoles,
  type PlatformRoleChange,
  PlatformRoleError,
  type PlatformRoleHolder,
  type PlatformRoleResult,
  revokePlatformRole,
} from './platform-roles.js';

const USAGE = [
  'usage: platform-roles grant <email> <role> [--reason "<why>"]',
  '       platform-roles revoke <email> <role> [--reason "<why>"]',
  '       platform-roles list',
  `roles: ${PLATFORM_ROLES.join(', ')}`,
  'The person must have registered with that address, verified it and signed in once.',
].join('\n');

export interface PlatformRolesCliDeps {
  grant: (change: PlatformRoleChange) => Promise<PlatformRoleResult>;
  revoke: (change: PlatformRoleChange) => Promise<PlatformRoleResult>;
  list: () => Promise<PlatformRoleHolder[]>;
  print: (line: string) => void;
  printError: (line: string) => void;
}

/** Runs one command; returns the process exit code (0 done, 1 refused, 2 bad usage). */
export async function runPlatformRolesCli(
  argv: string[],
  deps: PlatformRolesCliDeps,
): Promise<number> {
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
  const [command, email, role, ...extra] = parsed.positionals;
  const change = (): PlatformRoleChange => ({
    email: email ?? '',
    role: role ?? '',
    reason: parsed.values.reason,
  });
  try {
    if (command === 'list' && !email) {
      const holders = await deps.list();
      if (holders.length === 0) deps.print('No platform roles granted.');
      for (const h of holders) {
        deps.print(
          `${h.role.padEnd(18)} ${h.email.padEnd(40)} ${h.fullName}${h.status === 'active' ? '' : ` (${h.status})`}  · by ${h.grantedBy}, ${h.grantedAt.slice(0, 10)}`,
        );
      }
      return 0;
    }
    if ((command === 'grant' || command === 'revoke') && email && role && extra.length === 0) {
      const result = command === 'grant' ? await deps.grant(change()) : await deps.revoke(change());
      const verb = { granted: 'granted', revoked: 'revoked', unchanged: 'unchanged' }[
        result.outcome
      ];
      const preposition = command === 'grant' ? 'to' : 'from';
      deps.print(
        `${verb}: ${result.role} ${preposition} ${result.email}${result.outcome === 'unchanged' ? ' (nothing to do)' : ''}`,
      );
      return 0;
    }
    deps.printError(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof PlatformRoleError) {
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
  try {
    process.exitCode = await runPlatformRolesCli(process.argv.slice(2), {
      grant: (change) => grantPlatformRole(prisma, audit, change),
      revoke: (change) => revokePlatformRole(prisma, audit, change),
      list: () => listPlatformRoles(prisma),
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
