import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Configuration of the reference citizen app. It plays the country's citizen app: it has its
 * own users (through the national identity), its own contact data and its own notices, and it
 * talks to the portal only through the citizen API and the public evidence endpoints.
 */
export interface CitizenAppConfig {
  /** Public base URL, possibly with a path (https://host/citizen-app). Routes live under its path. */
  publicUrl: string;
  basePath: string;
  port: number;
  /** Shown in the header; the app is a reference, not the real citizen app of any country. */
  name: { es: string; en: string };
  oidc: {
    /** Public issuer of the national identity (den-citizens in development). */
    issuer: string;
    /** Where this server reaches the issuer (in containers, by service name); default issuer. */
    internalUrl: string;
    clientId: string;
    clientSecret: string;
  };
  portal: {
    /** Citizen API of the portal. */
    apiUrl: string;
    /**
     * Public material the app chooses to trust for receipts, fetched from where it is
     * published: the operator's JWKS and the TSA's certificate chain.
     */
    jwksUrl: string;
    tsaRootUrl: string;
    /**
     * The TSA's roots pinned in a PEM file (ADR-0032): the accredited TSA's, as its accreditation
     * publishes them. When set, tsaRootUrl is not used. Without it, the chain is fetched from
     * tsaRootUrl, which by default is the development TSA's own (it vouches for itself).
     */
    tsaRootsFile: string | null;
  };
  /** Standard Webhooks secret shared with the portal (DEN_CITIZEN_APPS). */
  webhookSecret: string;
  smtp: { host: string; port: number; from: string };
  /** Where the app keeps which alert id belongs to which of its users. */
  dataFile: string;
}

/**
 * Why the app's trust in time-stamps is the development TSA's, or null (M-14): no roots pinned
 * by file, and the chain comes from the endpoint the development TSA serves about itself.
 */
export function developmentTsaTrust(config: CitizenAppConfig): string | null {
  if (config.portal.tsaRootsFile) return null;
  return config.portal.tsaRootUrl.endsWith('/api/v1/timestamp/certchain')
    ? `the TSA's chain is fetched from the development TSA itself (${config.portal.tsaRootUrl}); ` +
        "pin the accredited TSA's roots with CITIZEN_APP_TSA_ROOTS_FILE"
    : null;
}

/** Loads the repo-root .env in development, as apps/web and apps/api do. */
export function loadRootEnv(start = process.cwd()): void {
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

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
};

export function configFromEnv(): CitizenAppConfig {
  const publicUrl = (process.env.DEN_CITIZEN_APP_URL ?? 'http://localhost:3100').replace(
    /\/+$/,
    '',
  );
  const issuer = process.env.DEN_CITIZEN_ISSUER ?? 'http://localhost:8080/realms/den-citizens';
  const apiUrl = (
    process.env.CITIZEN_APP_PORTAL_API_URL ??
    process.env.DEN_API_URL ??
    'http://localhost:4000'
  ).replace(/\/+$/, '');
  // The development TSA's base (sigstore timestamp-server); see tsaSettings in the API.
  const tsaUrl = (process.env.DEN_TSA_URL ?? 'http://localhost:3004')
    .replace(/\/+$/, '')
    .replace(/\/api\/v1\/timestamp$/, '');
  return {
    publicUrl,
    basePath: new URL(publicUrl).pathname.replace(/\/+$/, ''),
    port: Number(process.env.CITIZEN_APP_PORT ?? 3100),
    name: {
      es: process.env.CITIZEN_APP_NAME_ES ?? 'Aplicación ciudadana (referencia)',
      en: process.env.CITIZEN_APP_NAME_EN ?? 'Citizen app (reference)',
    },
    oidc: {
      issuer,
      internalUrl: process.env.CITIZEN_APP_ISSUER_INTERNAL_URL ?? issuer,
      clientId: process.env.CITIZEN_APP_CLIENT_ID ?? 'citizen-app',
      clientSecret: required('DEN_CITIZEN_APP_CLIENT_SECRET'),
    },
    portal: {
      apiUrl,
      jwksUrl: process.env.CITIZEN_APP_JWKS_URL ?? `${apiUrl}/api/v1/transparency/jwks`,
      tsaRootUrl: process.env.CITIZEN_APP_TSA_ROOT_URL ?? `${tsaUrl}/api/v1/timestamp/certchain`,
      tsaRootsFile: process.env.CITIZEN_APP_TSA_ROOTS_FILE?.trim() || null,
    },
    webhookSecret: required('CITIZEN_APP_WEBHOOK_SECRET'),
    smtp: {
      host: process.env.CITIZEN_APP_SMTP_HOST ?? 'localhost',
      port: Number(process.env.CITIZEN_APP_SMTP_PORT ?? process.env.MAILPIT_SMTP_PORT ?? 1025),
      from: process.env.CITIZEN_APP_MAIL_FROM ?? 'avisos@citizen-app.demo.den.example',
    },
    dataFile: process.env.CITIZEN_APP_DATA_FILE ?? resolve('data/alerts.json'),
  };
}
