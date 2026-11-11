import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests against PostgreSQL (database rid_test, see infra/postgres/init).
// The global setup applies all migrations as the owner; tests connect as rid_app.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.int.test.ts'],
    setupFiles: ['reflect-metadata', './test/integration-env.ts'],
    globalSetup: ['./test/integration-global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
