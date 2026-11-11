/**
 * Country configuration loader. Full schema and YAML loading arrive in M0-06;
 * this module only fixes the public entry points.
 */
export const COUNTRY_ENV_VAR = 'RID_COUNTRY';

/** Resolves the country code from the environment, normalised to lower case. */
export function resolveCountryCode(env: NodeJS.ProcessEnv = process.env): string {
  const code = env[COUNTRY_ENV_VAR]?.trim().toLowerCase();
  if (!code) {
    throw new Error(`${COUNTRY_ENV_VAR} is not set`);
  }
  if (!/^[a-z]{2,8}$/.test(code)) {
    throw new Error(`${COUNTRY_ENV_VAR} must be a lower-case country code, got "${code}"`);
  }
  return code;
}
