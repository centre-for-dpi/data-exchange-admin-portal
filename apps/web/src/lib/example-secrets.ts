import { assertNoExampleSecrets, isDeployed } from '@den/config';

/** The web's own secrets (A-2): the session cookie's key and its client of den-portal. */
export const WEB_SECRETS = ['AUTH_SECRET', 'DEN_PORTAL_WEB_CLIENT_SECRET'] as const;

/**
 * M-25: a deployed web refuses to start while one of its secrets is the public value of
 * .env.example. Development and the local end-to-end tests (`next start` on localhost) keep them.
 */
export function assertWebSecretsAreNotExamples(env: NodeJS.ProcessEnv = process.env): void {
  assertNoExampleSecrets(WEB_SECRETS, {
    env,
    production: isDeployed(env.AUTH_URL ?? env.DEN_WEB_URL, env),
  });
}
