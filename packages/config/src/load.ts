import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse, YAMLParseError } from 'yaml';
import type { z } from 'zod';
import {
  countryConfigSchema,
  type CountryConfig,
  type LocalizedText,
  type UiLocale,
} from './schema.js';

export const COUNTRY_ENV_VAR = 'RID_COUNTRY';
export const CONFIG_DIR_ENV_VAR = 'RID_CONFIG_DIR';

/** Thrown when the country configuration is missing or invalid. Startup must stop on it. */
export class CountryConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  - ${i}`).join('\n')}` : message);
    this.name = 'CountryConfigError';
  }
}

/** Resolves the country code from the environment, normalised to lower case. */
export function resolveCountryCode(env: NodeJS.ProcessEnv = process.env): string {
  const code = env[COUNTRY_ENV_VAR]?.trim().toLowerCase();
  if (!code) {
    throw new CountryConfigError(`${COUNTRY_ENV_VAR} is not set`);
  }
  if (!/^[a-z]{2,8}$/.test(code)) {
    throw new CountryConfigError(
      `${COUNTRY_ENV_VAR} must be a lower-case country code, got "${code}"`,
    );
  }
  return code;
}

/**
 * Directory holding `<code>.yaml`: RID_CONFIG_DIR if set, otherwise the nearest `config/country`
 * walking up from `startDir` (apps run from their own folder inside the monorepo).
 */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string {
  const fromEnv = env[CONFIG_DIR_ENV_VAR]?.trim();
  if (fromEnv) return resolve(fromEnv);

  // turbopackIgnore: runtime path, so the Next.js file tracer does not walk the whole repository.
  let dir = resolve(/* turbopackIgnore: true */ startDir);
  for (;;) {
    const candidate = join(dir, 'config', 'country');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new CountryConfigError(
        `config/country not found above ${startDir}; set ${CONFIG_DIR_ENV_VAR}`,
      );
    }
    dir = parent;
  }
}

const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

/** Parses and validates one country YAML file. */
export function parseCountryConfigFile(file: string): CountryConfig {
  if (!existsSync(file)) {
    const dir = dirname(file);
    const available = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.yaml'))
          .map((f) => basename(f, '.yaml'))
      : [];
    throw new CountryConfigError(
      `Country configuration not found: ${file}. Available: ${available.join(', ') || 'none'}`,
      file,
    );
  }

  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'), { uniqueKeys: true, maxAliasCount: 50 });
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : String(error);
    throw new CountryConfigError(`Invalid YAML in ${file}`, file, [detail]);
  }

  const result = countryConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new CountryConfigError(
      `Invalid country configuration ${file}`,
      file,
      formatIssues(result.error),
    );
  }
  const config = result.data;

  const issues: string[] = [];
  const fileCode = basename(file, '.yaml');
  if (/^[a-z]{2}$/.test(fileCode) && config.country.code !== fileCode.toUpperCase()) {
    issues.push(`country.code: "${config.country.code}" does not match file name "${fileCode}"`);
  }
  const logo = isAbsolute(config.branding.logo)
    ? config.branding.logo
    : resolve(dirname(file), config.branding.logo);
  if (!existsSync(logo)) {
    issues.push(`branding.logo: file not found (${logo})`);
  }
  if (config.lifecycle.certificateExpiryWarningDays >= config.lifecycle.certificateValidityDays) {
    issues.push(
      'lifecycle.certificateExpiryWarningDays: must be lower than certificateValidityDays',
    );
  }
  if (issues.length > 0) {
    throw new CountryConfigError(`Invalid country configuration ${file}`, file, issues);
  }

  return { ...config, branding: { ...config.branding, logo } };
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides RID_CONFIG_DIR / directory discovery. */
  configDir?: string;
  /** Overrides RID_COUNTRY. */
  code?: string;
}

/** Loads `config/country/<RID_COUNTRY>.yaml`. Throws CountryConfigError when invalid. */
export function loadCountryConfig(options: LoadOptions = {}): CountryConfig {
  const env = options.env ?? process.env;
  const code = options.code ?? resolveCountryCode(env);
  const dir = options.configDir ?? resolveConfigDir(env);
  return parseCountryConfigFile(join(dir, `${code}.yaml`));
}

let cached: CountryConfig | undefined;

/** Process-wide configuration, loaded once. Call it at startup so an invalid file stops the process. */
export function getCountryConfig(): CountryConfig {
  cached ??= loadCountryConfig();
  return cached;
}

/** Text in the requested UI language, falling back to the other one. */
export function localize(text: LocalizedText, locale: UiLocale): string {
  if (typeof text === 'string') return text;
  return text[locale] ?? text.es ?? text.en ?? '';
}
