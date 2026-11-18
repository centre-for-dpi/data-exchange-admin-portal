export {
  CONFIG_DIR_ENV_VAR,
  COUNTRY_ENV_VAR,
  CountryConfigError,
  getCountryConfig,
  loadCountryConfig,
  localize,
  parseCountryConfigFile,
  resolveConfigDir,
  resolveCountryCode,
  type LoadOptions,
} from './load.js';
export {
  DEFAULT_UPSTREAMS,
  UI_LOCALES,
  UPSTREAM_TYPES,
  countryConfigSchema,
  localizedTextSchema,
  type CountryConfig,
  type CountryConfigInput,
  type LocalizedText,
  type UiLocale,
  type UpstreamType,
} from './schema.js';
