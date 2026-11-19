import { assertNoExampleSecrets } from '@den/config';

/**
 * The API's secrets (M-25). In production (NODE_ENV=production, the image) the API refuses to
 * start while one of them still has its `.env.example` value: those keys are public in the
 * repository. `scripts/make-deploy-env.mjs` and `install.sh` generate every one of them.
 */
export const API_SECRETS = [
  'DATABASE_URL',
  'DEN_SECRETS_KEY',
  'DEN_SUBJECT_REF_KEY',
  'DEN_END_USER_HASH_SALT',
  'DEN_TRANSPARENCY_SIGNING_JWK',
  'DEN_TRANSPARENCY_INGEST_TOKEN',
  'DEN_CITIZEN_APPS',
  'DEN_GATEWAY_PROVISIONER_SECRET',
  'APISIX_ADMIN_KEY',
  'OPA_BUNDLE_TOKEN',
  'DEN_OPA_DECISION_TOKEN',
  'DEN_STEP_CA_PROVISIONER_PASSWORD',
  'DEN_STEP_CA_GATEWAY_PROVISIONER_PASSWORD',
  'DEN_STEP_CA_NODE_PROVISIONER_PASSWORD',
  'DEN_METRICS_TOKEN',
  'DEN_NODE_CONTROL_TOKEN',
  'DEN_VALIDATION_TOKEN',
  'DEN_CONTRACT_RUNNER_TOKEN',
  'DEN_WG_HUB_AGENT_TOKEN',
  // Public, but the example one means the hub runs with the example private key.
  'DEN_WG_HUB_PUBLIC_KEY',
] as const;

/** Values that carry another example secret inside: the database password, a webhook secret. */
const EMBEDDED = {
  DATABASE_URL: ['DEN_APP_DB_PASSWORD'],
  DEN_CITIZEN_APPS: ['CITIZEN_APP_WEBHOOK_SECRET'],
  // Commented out in .env.example: the development CA's password is the example.
  DEN_STEP_CA_GATEWAY_PROVISIONER_PASSWORD: ['DEN_STEP_CA_PROVISIONER_PASSWORD'],
  DEN_STEP_CA_NODE_PROVISIONER_PASSWORD: ['DEN_STEP_CA_PROVISIONER_PASSWORD'],
};

/** Throws in production when one of the API's secrets is the example's (see API_SECRETS). */
export function assertApiSecretsAreNotExamples(
  options: { env?: NodeJS.ProcessEnv; production?: boolean; startDir?: string } = {},
): void {
  assertNoExampleSecrets(API_SECRETS, { ...options, embedded: EMBEDDED });
}
