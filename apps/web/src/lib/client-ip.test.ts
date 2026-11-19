import { describe, expect, it } from 'vitest';
import { clientAddress } from './client-ip';

describe('clientAddress (M-27)', () => {
  it('takes the entry the proxy appended, the last one', () => {
    expect(clientAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('10.9.9.9, 198.51.100.4')).toBe('198.51.100.4');
    expect(clientAddress('2001:db8::1')).toBe('2001:db8::1');
  });

  it('ignores what is not an address', () => {
    expect(clientAddress(null)).toBeUndefined();
    expect(clientAddress('')).toBeUndefined();
    expect(clientAddress('198.51.100.4, unknown')).toBeUndefined();
    expect(clientAddress('198.51.100.4, ')).toBeUndefined();
  });
});
