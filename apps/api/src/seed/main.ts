// `pnpm db:seed`: loads development data (M1-01). Idempotent: safe to run repeatedly.
import { getCountryConfig } from '@rid/config';
import { AuditService } from '../audit/audit.service.js';
import { loadDevEnv } from '../dev-env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from './realm.js';
import { runSeed } from './seed.js';

async function main(): Promise<void> {
  loadDevEnv();
  if (process.env.NODE_ENV === 'production' && process.env.RID_ALLOW_SEED !== 'true') {
    throw new Error('Refusing to seed in production (set RID_ALLOW_SEED=true to override)');
  }
  const prisma = new PrismaService();
  try {
    const summary = await runSeed(prisma, new AuditService(), {
      config: getCountryConfig(),
      realmUsers: readRealmUsers(),
    });
    console.warn(
      `Seed done: created ${JSON.stringify(summary.created)}, updated ${JSON.stringify(summary.updated)}`,
    );
    for (const warning of summary.warnings) console.warn(`  warning: ${warning}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
