import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuidv7.js';

describe('uuidv7', () => {
  it('has the version 7 and RFC 9562 variant bits', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the timestamp in the first 48 bits, so ids sort by creation time', () => {
    const id = uuidv7(0x0123456789ab);
    expect(id.startsWith('01234567-89ab-7')).toBe(true);
    expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
  });

  it('is unique', () => {
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7(42))).size).toBe(1000);
  });
});
