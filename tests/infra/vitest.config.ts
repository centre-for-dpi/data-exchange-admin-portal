import { defineConfig } from 'vitest/config';

// Static checks only: run in CI without any container.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
  },
});
