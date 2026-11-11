import { defineConfig } from 'vitest/config';

// Needs the stack running (`pnpm infra:up`). Run with `pnpm test:integration`.
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    setupFiles: ['src/env.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
