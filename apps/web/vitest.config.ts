import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Auth.js and next-intl import `next/server` without an extension; inlined, vite resolves it
    // (the proxy test runs the real ones).
    server: { deps: { inline: [/next-auth/, /@auth\/core/, /next-intl/] } },
  },
});
