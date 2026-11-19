// `pnpm identity-relink <email> [--sub <keycloak user id>] [--new-email <address>] --reason "<why>"`;
// in a deployment, `./install.sh relink-identity ...` or `node dist/admin/identity-relink-cli.js ...`
// inside the api container. Points an existing portal account at a new Keycloak user or address,
// audited (identity-relink.ts, B-22).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AuditService } from '../audit/audit.service.js';
import { loadDevEnv } from '../dev-env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type IdentityRelink,
  IdentityRelinkError,
  type IdentityRelinkResult,
  relinkIdentity,
} from './identity-relink.js';

const USAGE = [
  'usage: identity-relink <current-email> [--sub <keycloak-user-id>] [--new-email <address>] --reason "<why>"',
  'Points the portal account at a new Keycloak user (its ID, from the Keycloak console) and/or a new',
  'address; memberships and roles stay with the account. The new identity must not have signed in',
  'to the portal yet. The person enrolls the second factor again in the new Keycloak user.',
].join('\n');

export interface IdentityRelinkCliDeps {
  relink: (change: IdentityRelink) => Promise<IdentityRelinkResult>;
  print: (line: string) => void;
  printError: (line: string) => void;
}

/** Runs the command; returns the process exit code (0 done, 1 refused, 2 bad usage). */
export async function runIdentityRelinkCli(
  argv: string[],
  deps: IdentityRelinkCliDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        sub: { type: 'string' },
        'new-email': { type: 'string' },
        reason: { type: 'string' },
      },
    });
  } catch (error) {
    deps.printError(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const [email, ...extra] = parsed.positionals;
  if (!email || extra.length > 0) {
    deps.printError(USAGE);
    return 2;
  }
  try {
    const result = await deps.relink({
      email,
      newSub: parsed.values.sub,
      newEmail: parsed.values['new-email'],
      reason: parsed.values.reason ?? '',
    });
    deps.print(
      result.outcome === 'unchanged'
        ? `unchanged: ${result.email} already has that identity (nothing to do)`
        : `relinked: ${result.email} -> Keycloak user ${result.keycloakSub}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof IdentityRelinkError) {
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
    process.exitCode = await runIdentityRelinkCli(process.argv.slice(2), {
      relink: (change) => relinkIdentity(prisma, audit, change),
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
