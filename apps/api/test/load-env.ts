import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Points the API at the integration-test database (den_test) using the repo-root .env. */
export function useTestDatabase(): void {
  const rootEnv = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const app = process.env.TEST_DATABASE_URL;
  const owner = process.env.TEST_DATABASE_MIGRATION_URL;
  if (!app || !owner) {
    throw new Error('TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL must be set (.env.example)');
  }
  process.env.DATABASE_URL = app;
  process.env.DATABASE_MIGRATION_URL = owner;
  process.env.DEN_WORKER = 'off';
}
