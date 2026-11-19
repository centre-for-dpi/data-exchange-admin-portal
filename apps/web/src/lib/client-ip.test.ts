import { describe, expect, it } from 'vitest';
import { clientAddress, forwardedFor, PROXY_TOKEN_HEADER } from './client-ip';

const TOKEN = 'proxy-token-of-this-deployment';
const request = (entries: Record<string, string>) => new Headers(entries);

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

describe('forwardedFor: only what came through the proxy (M-27)', () => {
  it('honours the address the proxy appended when the hop carries its token', () => {
    const viaProxy = request({
      [PROXY_TOKEN_HEADER]: TOKEN,
      // A client's own guess first, then what the proxy saw: the last one counts.
      'x-forwarded-for': '1.2.3.4, 198.51.100.4',
    });
    expect(forwardedFor(viaProxy, TOKEN)).toEqual({ 'x-forwarded-for': '198.51.100.4' });
  });

  it('ignores a spoofed X-Forwarded-For from a peer that is not the proxy', () => {
    // Reached the web directly: no token, or a guessed one.
    expect(forwardedFor(request({ 'x-forwarded-for': '1.2.3.4' }), TOKEN)).toEqual({});
    expect(
      forwardedFor(request({ [PROXY_TOKEN_HEADER]: 'guess', 'x-forwarded-for': '1.2.3.4' }), TOKEN),
    ).toEqual({});
    expect(
      forwardedFor(
        request({ [PROXY_TOKEN_HEADER]: `${TOKEN}x`, 'x-forwarded-for': '1.2.3.4' }),
        TOKEN,
      ),
    ).toEqual({});
  });

  it('forwards nothing when no token is configured (development)', () => {
    const anything = request({ [PROXY_TOKEN_HEADER]: '', 'x-forwarded-for': '1.2.3.4' });
    expect(forwardedFor(anything, undefined)).toEqual({});
    expect(forwardedFor(anything, '')).toEqual({});
  });
});
