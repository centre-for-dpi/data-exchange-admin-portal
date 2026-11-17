import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env files: load the repo-root .env (same as Docker Compose).
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Migrations run as the schema owner, never as the runtime role (den_app).
  // Empty when unset so `prisma generate` works in CI without a database.
  datasource: { url: process.env.DATABASE_MIGRATION_URL ?? '' },
});
