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
  UI_LOCALES,
  countryConfigSchema,
  localizedTextSchema,
  type CountryConfig,
  type CountryConfigInput,
  type LocalizedText,
  type UiLocale,
} from './schema.js';
