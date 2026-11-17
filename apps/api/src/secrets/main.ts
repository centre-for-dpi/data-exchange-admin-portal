// `pnpm --filter @den/api secrets:reseal` (in the image: `node dist/secrets/main.js`): seals
// again with DEN_SECRETS_KEY what a previous key sealed (OPERATIONS.md §5.6).
import { AuditService } from '../audit/audit.service.js';
import { loadDevEnv } from '../dev-env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { resealAll } from './reseal.js';

async function main(): Promise<void> {
  loadDevEnv();
  const prisma = new PrismaService();
  try {
    const { keyId, resealed } = await resealAll(prisma, new AuditService());
    console.warn(`Sealed values now under key ${keyId}; resealed ${JSON.stringify(resealed)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
