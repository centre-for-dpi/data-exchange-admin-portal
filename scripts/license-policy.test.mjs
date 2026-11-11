import { describe, expect, it } from 'vitest';
import { evaluateLicenses, isLicenseAllowed, parseSpdx } from './license-policy.mjs';

describe('isLicenseAllowed', () => {
  it.each([
    'MIT',
    'Apache-2.0',
    '0BSD',
    'BlueOak-1.0.0',
    'Python-2.0',
    'MPL-2.0',
    'LGPL-3.0-or-later',
  ])('allows %s', (license) => {
    expect(isLicenseAllowed(license)).toBe(true);
  });

  it.each([
    'GPL-3.0-only',
    'AGPL-3.0-or-later',
    'SSPL-1.0',
    'BUSL-1.1',
    'Elastic-2.0',
    'CC-BY-4.0',
    'CC0-1.0',
    'UNLICENSED',
    'Unknown',
    '',
  ])('rejects %s', (license) => {
    expect(isLicenseAllowed(license)).toBe(false);
  });

  it('accepts OR when one side is allowed', () => {
    expect(isLicenseAllowed('(MIT OR CC0-1.0)')).toBe(true);
    expect(isLicenseAllowed('GPL-3.0-only OR Apache-2.0')).toBe(true);
  });

  it('requires every side of AND to be allowed', () => {
    expect(isLicenseAllowed('Apache-2.0 AND MIT')).toBe(true);
    expect(isLicenseAllowed('Apache-2.0 AND LGPL-3.0-or-later')).toBe(true);
    expect(isLicenseAllowed('MIT AND CC-BY-4.0')).toBe(false);
  });

  it('gives AND precedence over OR', () => {
    // MIT OR (GPL AND Apache) → allowed through MIT.
    expect(isLicenseAllowed('MIT OR GPL-3.0-only AND Apache-2.0')).toBe(true);
    // (GPL AND MIT) OR GPL → not allowed.
    expect(isLicenseAllowed('GPL-3.0-only AND MIT OR GPL-2.0-only')).toBe(false);
  });

  it('treats WITH clauses as part of the license id', () => {
    expect(isLicenseAllowed('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(isLicenseAllowed('(MIT OR')).toBe(false);
    expect(isLicenseAllowed('MIT AND')).toBe(false);
  });
});

describe('parseSpdx', () => {
  it('parses nested expressions', () => {
    expect(parseSpdx('(MIT OR Apache-2.0) AND BSD-3-Clause')).toEqual({
      type: 'and',
      left: {
        type: 'or',
        left: { type: 'license', id: 'MIT' },
        right: { type: 'license', id: 'Apache-2.0' },
      },
      right: { type: 'license', id: 'BSD-3-Clause' },
    });
  });
});

describe('evaluateLicenses', () => {
  const exception = {
    package: 'caniuse-lite',
    license: 'CC-BY-4.0',
    reason: 'Browser compatibility data, not code',
    addedAt: '2026-11-11',
  };

  it('passes allowed packages and applies per-package exceptions', () => {
    const report = evaluateLicenses(
      {
        MIT: [{ name: 'a', versions: ['1.0.0'], license: 'MIT' }],
        'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.0'], license: 'CC-BY-4.0' }],
      },
      [exception],
    );
    expect(report.violations).toEqual([]);
    expect(report.excepted.map((p) => p.name)).toEqual(['caniuse-lite']);
    expect(report.unusedExceptions).toEqual([]);
    expect(report.total).toBe(2);
  });

  it('does not extend an exception to other packages with the same license', () => {
    const report = evaluateLicenses(
      { 'CC-BY-4.0': [{ name: 'some-code', versions: ['2.0.0'], license: 'CC-BY-4.0' }] },
      [exception],
    );
    expect(report.violations.map((p) => p.name)).toEqual(['some-code']);
    expect(report.unusedExceptions).toEqual([exception]);
  });

  it('does not apply an exception when the license changed', () => {
    const report = evaluateLicenses(
      { 'SSPL-1.0': [{ name: 'caniuse-lite', versions: ['9.0.0'], license: 'SSPL-1.0' }] },
      [exception],
    );
    expect(report.violations.map((p) => p.name)).toEqual(['caniuse-lite']);
  });

  it('flags forbidden licenses', () => {
    const report = evaluateLicenses(
      { 'AGPL-3.0-only': [{ name: 'bad', versions: ['1.0.0'], license: 'AGPL-3.0-only' }] },
      [],
    );
    expect(report.violations).toEqual([
      { name: 'bad', versions: ['1.0.0'], license: 'AGPL-3.0-only' },
    ]);
  });
});
