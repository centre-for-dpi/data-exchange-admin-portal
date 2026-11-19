import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, type Tags } from 'yaml';
import { fromRoot } from './paths.js';

/**
 * The pilot's containers get only the variables they use (A-2): no service loads the whole .env,
 * the web and the citizen app (a demo prop on the internet) hold none of the platform's secrets,
 * and only the one-shot `migrate` knows the schema owner's password.
 */

// Compose's merge tags (`!reset`, `!override`): their value is all a static check needs.
const composeTags: Tags = ['!reset', '!override'].flatMap((tag) => [
  { tag, collection: 'map' as const, identify: () => false, resolve: (v: unknown) => v },
  { tag, collection: 'seq' as const, identify: () => false, resolve: (v: unknown) => v },
  { tag, identify: () => false, resolve: (v: string) => v },
]);

interface Service {
  env_file?: unknown;
  environment?: Record<string, string | null> | string[];
  depends_on?: Record<string, { condition?: string }>;
  command?: unknown;
}
const overlay = parse(readFileSync(fromRoot('infra/compose/docker-compose.deploy.yml'), 'utf8'), {
  customTags: composeTags,
}) as { services: Record<string, Service> };

const environment = (name: string): Record<string, string | null> => {
  const env = overlay.services[name]?.environment;
  if (!env || Array.isArray(env)) throw new Error(`${name}: environment must be a map`);
  return env;
};

/** The platform's secrets: none of them belongs in the web or the citizen app. */
const PLATFORM_SECRETS = [
  'POSTGRES_PASSWORD',
  'DEN_APP_DB_PASSWORD',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'TEST_DATABASE_URL',
  'TEST_DATABASE_MIGRATION_URL',
  'KEYCLOAK_DB_PASSWORD',
  'KEYCLOAK_ADMIN_PASSWORD',
  'STEP_CA_PASSWORD',
  'DEN_STEP_CA_PROVISIONER_PASSWORD',
  'DEN_SECRETS_KEY',
  'DEN_SUBJECT_REF_KEY',
  'DEN_END_USER_HASH_SALT',
  'DEN_TRANSPARENCY_SIGNING_JWK',
  'DEN_TRANSPARENCY_INGEST_TOKEN',
  'PGBACKREST_REPO1_CIPHER_PASS',
  'APISIX_ADMIN_KEY',
  'DEN_APISIX_KEYRING',
  'OPA_BUNDLE_TOKEN',
  'DEN_OPA_DECISION_TOKEN',
  'DEN_OPA_ADMIN_TOKEN',
  'ETCD_ROOT_PASSWORD',
  'APISIX_ETCD_PASSWORD',
  'DEN_GATEWAY_PROVISIONER_SECRET',
  'DEN_METRICS_TOKEN',
  'DEN_NODE_CONTROL_TOKEN',
  'DEN_VALIDATION_TOKEN',
  'DEN_CONTRACT_RUNNER_TOKEN',
  'DEN_WG_HUB_AGENT_TOKEN',
  'DEN_WG_HUB_PRIVATE_KEY',
  'DEN_CITIZEN_APPS',
  'DEN_DEMO_USER_PASSWORD',
  'DEN_DEMO_TOTP_SECRET',
  'GRAFANA_ADMIN_PASSWORD',
  'MAILPIT_UI_AUTH',
];
/** Secrets the API does not need either: the database owner, Keycloak's master, the CA's keys… */
const NOT_FOR_THE_API = [
  'POSTGRES_PASSWORD',
  'DEN_APP_DB_PASSWORD',
  'DATABASE_MIGRATION_URL',
  'TEST_DATABASE_URL',
  'TEST_DATABASE_MIGRATION_URL',
  'KEYCLOAK_DB_PASSWORD',
  'KEYCLOAK_ADMIN_USER',
  'KEYCLOAK_ADMIN_PASSWORD',
  'STEP_CA_PASSWORD',
  'PGBACKREST_REPO1_CIPHER_PASS',
  'DEN_APISIX_KEYRING',
  'DEN_OPA_ADMIN_TOKEN',
  'ETCD_ROOT_PASSWORD',
  'APISIX_ETCD_PASSWORD',
  'DEN_WG_HUB_PRIVATE_KEY',
  'DEN_DEMO_USER_PASSWORD',
  'DEN_DEMO_TOTP_SECRET',
  'DEN_PORTAL_WEB_CLIENT_SECRET',
  'DEN_CITIZEN_APP_CLIENT_SECRET',
  'CITIZEN_APP_WEBHOOK_SECRET',
  'AUTH_SECRET',
  'DEN_WEB_PROXY_TOKEN',
  'GRAFANA_ADMIN_PASSWORD',
  'MAILPIT_UI_AUTH',
];

/** A forbidden variable, as a key or inside a value (`FOO: ${POSTGRES_PASSWORD}`). */
function leaks(env: Record<string, string | null>, forbidden: string[]): string[] {
  return forbidden.filter(
    (name) =>
      name in env ||
      Object.values(env).some((value) => new RegExp(`\\$\\{${name}\\b`).test(value ?? '')),
  );
}

describe('deploy overlay: each container gets only its own variables (A-2)', () => {
  it('no service loads the whole .env', () => {
    for (const [name, service] of Object.entries(overlay.services)) {
      expect(service.env_file, name).toBeUndefined();
    }
  });

  it('api, web, citizen-app and migrate list their environment', () => {
    for (const name of ['api', 'web', 'citizen-app', 'migrate']) {
      expect(Object.keys(environment(name)).length, name).toBeGreaterThan(0);
    }
  });

  it('the web and the citizen app hold none of the platform secrets', () => {
    expect(leaks(environment('web'), PLATFORM_SECRETS)).toEqual([]);
    expect(leaks(environment('citizen-app'), PLATFORM_SECRETS)).toEqual([]);
    // Nor each other's.
    expect(
      leaks(environment('web'), ['DEN_CITIZEN_APP_CLIENT_SECRET', 'CITIZEN_APP_WEBHOOK_SECRET']),
    ).toEqual([]);
    expect(
      leaks(environment('citizen-app'), [
        'AUTH_SECRET',
        'DEN_PORTAL_WEB_CLIENT_SECRET',
        'DEN_WEB_PROXY_TOKEN',
      ]),
    ).toEqual([]);
  });

  it('the API runs as den_app: no owner password, no Keycloak master, no CA key', () => {
    expect(leaks(environment('api'), NOT_FOR_THE_API)).toEqual([]);
    expect(environment('api').DATABASE_URL).toMatch(/\$\{DATABASE_URL:\?/);
  });

  it('migrations run before the API, as the schema owner, in a container of their own', () => {
    expect(Object.keys(environment('migrate'))).toEqual(['DATABASE_MIGRATION_URL']);
    expect(overlay.services.migrate?.command).toEqual([
      'node_modules/.bin/prisma',
      'migrate',
      'deploy',
    ]);
    expect(overlay.services.api?.depends_on?.migrate?.condition).toBe(
      'service_completed_successfully',
    );
    // The API's own command does not migrate (an image from before A-2 would).
    expect(JSON.stringify(overlay.services.api?.command)).not.toContain('migrate');
  });
});

/** Every `.ts` source file under a directory, without tests and generated code. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'generated' && entry !== 'node_modules') out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const ENV_NAME =
  /^(?:DEN|AUTH|KEYCLOAK|CITIZEN_APP|DATABASE|APISIX|OPA|API|LOG|MAILPIT)_[A-Z0-9_]+$/;
/** The variables a body of code reads: `process.env.X`, `env.X`, `env['X']` or a lone `'X'`. */
function variablesRead(dirs: string[]): Set<string> {
  const found = new Set<string>();
  const patterns = [
    /process\.env(?:\.|\[['"])([A-Z][A-Z0-9_]+)/g,
    /\benv\??\.([A-Z][A-Z0-9_]{2,})\b/g,
    /\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
    /['"`]([A-Z][A-Z0-9_]+)['"`]/g,
  ];
  for (const file of dirs.flatMap((d) => sources(fromRoot(d)))) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const match of text.matchAll(re)) {
        if (ENV_NAME.test(match[1]!)) found.add(match[1]!);
      }
    }
  }
  return found;
}

/**
 * Read by the code but deliberately not given to the container: development and test switches,
 * tools that do not run in it, and names that are not variables.
 */
const NOT_IN_THE_CONTAINER: Record<string, string[]> = {
  api: [
    'DATABASE_MIGRATION_URL', // the `migrate` service's (prisma.config.ts)
    'KEYCLOAK_ADMIN_USER', // demo-users CLI: install.sh passes them for that command only
    'KEYCLOAK_ADMIN_PASSWORD',
    'KEYCLOAK_ADMIN', // injection tokens, not variables
    'APISIX_ADMIN',
    'APISIX_SETTINGS',
    'DEN_APP_DB_PASSWORD', // only their example values are compared (M-25), inside others
    'CITIZEN_APP_WEBHOOK_SECRET',
    'KEYCLOAK_ADMIN_TIMEOUT_MS',
    'DEN_ALLOW_LOAD_SEED', // load test seed (tsx, development)
    'DEN_ALLOW_SYNTHETIC_TRAFFIC', // traffic simulator (tsx, development)
    'DEN_CONFIG_DIR', // the image has config/country in place
    'DEN_POLICY_DIR', // the image has the policies in place
    'APISIX_HTTP_PORT', // development ports
    'APISIX_HTTPS_PORT',
    'OPA_PORT',
  ],
  web: [
    'DEN_CONFIG_DIR',
    // Lines of the integration guide shown to developers, not the web's own.
    'DEN_CLIENT_SECRET',
    'DEN_P12_PASSWORD',
  ],
  'citizen-app': [
    'DEN_CONFIG_DIR', // the image has config/country in place
    'DEN_API_URL', // CITIZEN_APP_PORTAL_API_URL is set
    'DEN_TSA_URL', // CITIZEN_APP_TSA_ROOT_URL is set
    'MAILPIT_SMTP_PORT', // CITIZEN_APP_SMTP_PORT is set
    'CITIZEN_APP_PORT', // 3100, the image's
  ],
};

describe('deploy overlay: each container gets every variable its code reads', () => {
  const apps: Record<string, string[]> = {
    api: ['apps/api/src', 'packages/config/src'],
    web: ['apps/web/src', 'packages/config/src'],
    // It loads the country configuration and checks its secrets through packages/config too.
    'citizen-app': ['infra/mock-citizen-app/src', 'packages/config/src'],
  };
  it.each(Object.keys(apps))('%s', (name) => {
    const listed = new Set(Object.keys(environment(name)));
    const skipped = new Set(NOT_IN_THE_CONTAINER[name]);
    const missing = [...variablesRead(apps[name]!)].filter(
      (v) => !listed.has(v) && !skipped.has(v),
    );
    expect(missing.sort()).toEqual([]);
  });
});
