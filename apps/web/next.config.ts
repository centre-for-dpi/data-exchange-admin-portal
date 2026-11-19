import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCountryConfig } from '@den/config';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { STATIC_CSP, securityHeaders } from './src/lib/security-headers';

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

/**
 * The interface languages of the country (country.ui) reach the client bundle as build-time
 * variables (see src/i18n/ui-locales.ts). Without DEN_COUNTRY at build time (the generic image)
 * the defaults apply; instrumentation.ts stops a server whose configuration disagrees.
 */
function uiLocaleEnv(): Record<string, string> {
  if (!process.env.DEN_COUNTRY?.trim()) return {};
  const { ui } = getCountryConfig().country;
  return {
    NEXT_PUBLIC_DEN_UI_LOCALES: ui.locales.join(','),
    NEXT_PUBLIC_DEN_DEFAULT_UI_LOCALE: ui.defaultLocale,
  };
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: uiLocaleEnv(),
  poweredByHeader: false,
  // Security headers on every response (M3-09). Pages get their CSP with a nonce in the proxy;
  // the routes it does not see (Auth.js, the logo) a static one. File downloads set their own.
  headers() {
    return Promise.resolve([
      { source: '/:path*', headers: securityHeaders() },
      {
        source: '/:prefix(api|branding)/:path*',
        headers: [{ key: 'Content-Security-Policy', value: STATIC_CSP }],
      },
    ]);
  },
  experimental: {
    // Designation documents (PDF, up to the API's DEN_DOCUMENT_MAX_BYTES of 10 MiB) go through a
    // server action, which first passes the proxy; both default to smaller limits.
    serverActions: { bodySizeLimit: '11mb' },
    proxyClientMaxBodySize: '11mb',
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
