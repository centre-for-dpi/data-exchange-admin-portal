import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The user manual's own Playwright runs (docs/guides/user-manual.md), never part of test:e2e:
//   journey  captures the screenshots against a freshly reset local stack (pnpm docs:manual)
//   toolkit  checks the screenshot helper against the running portal
//   page     checks the generated manual page itself (no stack needed)
const rootEnv = resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const baseURL = process.env.DEN_WEB_URL ?? 'http://localhost:3000';
const needsStack = !process.argv.some((a) => a === '--project=page' || a === 'page');
const desktop = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
};

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: { baseURL, trace: 'retain-on-failure', actionTimeout: 30_000, navigationTimeout: 60_000 },
  projects: [
    {
      name: 'journey',
      testMatch: 'journey.manual.ts',
      timeout: 1_800_000,
      use: {
        ...desktop,
        locale: process.env.MANUAL_LANG === 'en' ? 'en-US' : 'es',
        // Native widgets (the file picker) follow the browser's own language, not the locale.
        launchOptions: { args: [`--lang=${process.env.MANUAL_LANG === 'en' ? 'en-US' : 'es'}`] },
      },
    },
    { name: 'toolkit', testMatch: 'toolkit.manual.ts', use: desktop },
    { name: 'page', testMatch: 'page.manual.ts', use: desktop },
  ],
  // Same servers as the main e2e config; the page project does not need them.
  webServer: needsStack
    ? [
        {
          command: 'pnpm -w exec turbo run build --filter=@den/api && pnpm --filter @den/api start',
          url: `${process.env.DEN_API_URL ?? 'http://localhost:4000'}/api/v1/health`,
          reuseExistingServer: true,
          timeout: 240_000,
        },
        {
          command: 'pnpm -w exec turbo run build --filter=@den/web... && pnpm start',
          url: baseURL,
          reuseExistingServer: true,
          timeout: 240_000,
        },
      ]
    : undefined,
});
