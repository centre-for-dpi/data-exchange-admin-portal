import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Loads the repo-root .env (the same file Docker Compose uses) when present, so `pnpm dev` and
 * local `pnpm start` work without exporting variables. Variables already set win. Production
 * images have no .env file and get their environment from the orchestrator.
 */
function loadRootEnv(start: string): void {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (existsSync(file)) process.loadEnvFile(file);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadRootEnv(process.cwd());

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Designation documents (PDF, up to the API's RID_DOCUMENT_MAX_BYTES of 10 MiB) go through a
    // server action, which first passes the proxy; both default to smaller limits.
    serverActions: { bodySizeLimit: '11mb' },
    proxyClientMaxBodySize: '11mb',
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
