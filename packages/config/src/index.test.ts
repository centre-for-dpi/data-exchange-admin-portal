import { describe, expect, it } from 'vitest';
import { resolveCountryCode } from './index.js';

describe('resolveCountryCode', () => {
  it('normalises the code to lower case', () => {
    expect(resolveCountryCode({ RID_COUNTRY: 'CO' })).toBe('co');
  });

  it('fails when the variable is missing', () => {
    expect(() => resolveCountryCode({})).toThrow(/RID_COUNTRY is not set/);
  });

  it('rejects values that could escape the config directory', () => {
    expect(() => resolveCountryCode({ RID_COUNTRY: '../co' })).toThrow(/country code/);
  });
});
