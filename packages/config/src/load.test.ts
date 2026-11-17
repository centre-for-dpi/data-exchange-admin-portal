import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  CountryConfigError,
  loadCountryConfig,
  localize,
  parseCountryConfigFile,
  resolveConfigDir,
  resolveCountryCode,
} from './index.js';

const repoConfigDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/country');
const coFile = join(repoConfigDir, 'co.yaml');

type Json = Record<string, unknown>;
const coRaw = (): Json => parse(readFileSync(coFile, 'utf8')) as Json;

/** Writes a config object as <code>.yaml in a fresh temp dir (with the files it references). */
function writeConfig(config: Json | string, code = 'co'): string {
  const dir = mkdtempSync(join(tmpdir(), 'den-config-'));
  mkdirSync(join(dir, 'branding', 'co'), { recursive: true });
  copyFileSync(join(repoConfigDir, 'branding/co/logo.svg'), join(dir, 'branding/co/logo.svg'));
  mkdirSync(join(dir, 'templates', 'co'), { recursive: true });
  copyFileSync(
    join(repoConfigDir, 'templates/co/acuerdo-intercambio.md'),
    join(dir, 'templates/co/acuerdo-intercambio.md'),
  );
  const file = join(dir, `${code}.yaml`);
  writeFileSync(file, typeof config === 'string' ? config : stringify(config));
  return file;
}

function expectInvalid(config: Json | string, ...messages: RegExp[]): void {
  const file = writeConfig(config);
  let error: unknown;
  try {
    parseCountryConfigFile(file);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(CountryConfigError);
  for (const message of messages) expect((error as Error).message).toMatch(message);
}

const set = (path: string, value: unknown): Json => {
  const config = coRaw();
  const keys = path.split('.');
  let node: Json = config;
  for (const key of keys.slice(0, -1)) node = node[key] as Json;
  const last = keys.at(-1) ?? '';
  if (value === undefined) delete node[last];
  else node[last] = value;
  return config;
};

describe('versioned country files', () => {
  it('co.yaml is valid and matches SPEC.md §10', () => {
    const config = loadCountryConfig({ code: 'co', configDir: repoConfigDir });
    expect(config.country).toEqual({
      code: 'CO',
      name: 'Colombia',
      locale: 'es-CO',
      timezone: 'America/Bogota',
    });
    expect(config.authorities.operator.shortName).toBe('AND');
    expect(config.authorities.regulator.shortName).toBe('MinTIC');
    expect(config.identifiers.person).toEqual(['CC', 'CE', 'TI', 'PEP', 'PPT', 'PA']);
    expect(config.purposes.map((p) => p.code)).toEqual(
      expect.arrayContaining(['eligibility_check', 'benefit_targeting', 'identity_validation']),
    );
    expect(config.features).toEqual({
      publicCatalog: false,
      mtls: { required: true }, // M3-10 closed ADR-0010
      sandbox: { autoApprove: true },
      approval: { regulatorForSensitive: true },
      lint: { noIdInQuery: true },
      gatewayAssertion: true,
    });
    expect(config.subscriptionMaxValidityMonths).toEqual({
      public: 24,
      internal: 24,
      personal: 12,
      sensitive: 6,
    });
    expect(config.branding.logo).toBe(join(repoConfigDir, 'branding/co/logo.svg'));
  });

  it('example.yaml is a valid template', () => {
    const config = loadCountryConfig({ code: 'example', configDir: repoConfigDir });
    expect(config.country.code).toBe('XX');
  });
});

describe('validation', () => {
  it('rejects a missing required field', () => {
    expectInvalid(set('authorities.regulator', undefined), /authorities\.regulator/);
  });

  it('rejects unknown keys so typos do not pass silently', () => {
    expectInvalid(set('features.publicCatalogue', true), /features/, /publicCatalogue/);
  });

  it('rejects an invalid time zone and locale', () => {
    expectInvalid(set('country.timezone', 'America/Gotham'), /country\.timezone/);
    expectInvalid(set('country.locale', 'not a locale!'), /country\.locale/);
  });

  it('rejects a country code that does not match the file name', () => {
    expectInvalid(set('country.code', 'PE'), /does not match file name "co"/);
  });

  it('rejects duplicate purpose codes', () => {
    const config = coRaw();
    const purposes = config.purposes as Json[];
    purposes.push({ ...purposes[0] });
    expectInvalid(config, /duplicate purpose code "eligibility_check"/);
  });

  it('rejects purpose codes that are not snake_case', () => {
    const config = coRaw();
    (config.purposes as Json[])[0] = {
      ...(config.purposes as Json[])[0],
      code: 'Eligibility-Check',
    };
    expectInvalid(config, /purposes\.0\.code/);
  });

  it('rejects an invalid color and a missing logo', () => {
    expectInvalid(set('branding.primaryColor', 'purple'), /branding\.primaryColor/);
    expectInvalid(
      set('branding.logo', './branding/co/missing.svg'),
      /branding\.logo: file not found/,
    );
  });

  it('resolves the agreement template next to the file and rejects a missing one (M2-07)', () => {
    const config = parseCountryConfigFile(coFile);
    expect(config.documents.agreementTemplate).toBe(
      join(repoConfigDir, 'templates/co/acuerdo-intercambio.md'),
    );
    expectInvalid(
      set('documents.agreementTemplate', './templates/co/missing.md'),
      /documents\.agreementTemplate: file not found/,
    );
    const without = parseCountryConfigFile(writeConfig(set('documents', undefined)));
    expect(without.documents.agreementTemplate).toBeUndefined();
  });

  it('rejects out-of-range validity periods', () => {
    expectInvalid(set('subscriptionMaxValidityMonths.sensitive', 0), /sensitive/);
  });

  it('rejects an expiry warning longer than the certificate validity', () => {
    expectInvalid(
      set('lifecycle.certificateExpiryWarningDays', 90),
      /certificateExpiryWarningDays/,
    );
  });

  it('reports YAML syntax errors and duplicate keys', () => {
    expectInvalid('country: [unclosed', /Invalid YAML/);
    expectInvalid(
      'country:\n  code: CO\ncountry:\n  code: CO\n',
      /Invalid YAML/,
      /[Dd]uplicate|unique/,
    );
  });

  it('applies SPEC.md defaults when lifecycle and retention are omitted', () => {
    const config = coRaw();
    delete config.lifecycle;
    delete config.retention;
    const loaded = parseCountryConfigFile(writeConfig(config));
    expect(loaded.lifecycle).toEqual({
      apiRetirementNoticeDays: 90,
      subscriptionRenewalNoticeDays: 30,
      certificateValidityDays: 90,
      certificateExpiryWarningDays: 15,
      credentialRotationDays: 7,
      enrollmentTokenValidityHours: 72,
      nodeOfflineAfterMinutes: 5,
      assertionKeyRotationDays: 90,
    });
    expect(loaded.retention).toEqual({
      auditYears: 5,
      accessLogMonths: 12,
      subjectAccessMonths: 60,
    });
  });

  it('accepts plain strings as localized texts', () => {
    const config = coRaw();
    (config.sectors as Json[])[0] = { code: 'identidad', name: 'Identidad' };
    expect(parseCountryConfigFile(writeConfig(config)).sectors[0]?.name).toBe('Identidad');
  });
});

describe('loading', () => {
  it('loads the file named by DEN_COUNTRY', () => {
    const config = loadCountryConfig({ env: { DEN_COUNTRY: 'CO', DEN_CONFIG_DIR: repoConfigDir } });
    expect(config.country.code).toBe('CO');
  });

  it('fails with the list of available countries when the file does not exist', () => {
    expect(() => loadCountryConfig({ code: 'zz', configDir: repoConfigDir })).toThrow(
      /not found.*Available: .*co/s,
    );
  });

  it('finds config/country by walking up from a nested directory', () => {
    const nested = resolve(repoConfigDir, '../../apps/api/src');
    expect(resolveConfigDir({}, nested)).toBe(repoConfigDir);
  });

  it('prefers DEN_CONFIG_DIR over discovery', () => {
    expect(resolveConfigDir({ DEN_CONFIG_DIR: '/somewhere/else' }, repoConfigDir)).toBe(
      resolve('/somewhere/else'),
    );
  });
});

describe('resolveCountryCode', () => {
  it('normalises the code to lower case', () => {
    expect(resolveCountryCode({ DEN_COUNTRY: 'CO' })).toBe('co');
  });

  it('fails when the variable is missing', () => {
    expect(() => resolveCountryCode({})).toThrow(/DEN_COUNTRY is not set/);
  });

  it('rejects values that could escape the config directory', () => {
    expect(() => resolveCountryCode({ DEN_COUNTRY: '../co' })).toThrow(/country code/);
  });
});

describe('localize', () => {
  it('returns the requested language and falls back to the other', () => {
    expect(localize({ es: 'Salud', en: 'Health' }, 'en')).toBe('Health');
    expect(localize({ es: 'Salud' }, 'en')).toBe('Salud');
    expect(localize('Salud', 'en')).toBe('Salud');
  });
});
