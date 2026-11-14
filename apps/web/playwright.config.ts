import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Same repo-root .env as Docker Compose and the apps (credentials of the seed users, ports).
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const baseURL = process.env.RID_WEB_URL ?? 'http://localhost:3000';

/**
 * End-to-end tests against the full local stack: `pnpm infra:up` first.
 * The API and the web app are built and started automatically unless already running.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 60_000,
  // Server-rendered pages and actions under `next dev` can take many seconds on a loaded machine;
  // CI runs the production build.
  expect: { timeout: process.env.CI ? 10_000 : 30_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Migrations and the (idempotent) seed run once before the suite.
  globalSetup: './e2e/global-setup.ts',
  webServer: [
    {
      command: 'pnpm -w exec turbo run build --filter=@rid/api && pnpm --filter @rid/api start',
      url: `${process.env.RID_API_URL ?? 'http://localhost:4000'}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      // The reference citizen folder (MT-07).
      command:
        'pnpm -w exec turbo run build --filter=@rid/mock-citizen-app... && pnpm --filter @rid/mock-citizen-app start',
      url: `${process.env.RID_CARPETA_URL ?? 'http://localhost:3100'}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      command: 'pnpm -w exec turbo run build --filter=@rid/web... && pnpm start',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
