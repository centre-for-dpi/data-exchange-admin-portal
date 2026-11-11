import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (instead of esbuild) so decorator metadata is emitted for NestJS dependency injection.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['reflect-metadata'],
  },
});
