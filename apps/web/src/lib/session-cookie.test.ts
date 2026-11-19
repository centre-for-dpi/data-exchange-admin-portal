import { describe, expect, it } from 'vitest';
import { applySessionCookies } from './session-cookie';

describe('applySessionCookies', () => {
  it('replaces the session cookie and keeps the others', () => {
    expect(
      applySessionCookies('NEXT_LOCALE=en; authjs.session-token=OLD', [
        'authjs.session-token=NEW; Path=/; HttpOnly',
      ]),
    ).toBe('NEXT_LOCALE=en; authjs.session-token=NEW');
  });

  it('replaces a chunked session cookie as a whole', () => {
    expect(
      applySessionCookies('__Secure-authjs.session-token.0=a; __Secure-authjs.session-token.1=b', [
        '__Secure-authjs.session-token.0=c; Path=/',
        '__Secure-authjs.session-token.1=; Max-Age=0',
      ]),
    ).toBe('__Secure-authjs.session-token.0=c');
  });

  it('leaves the request alone when no session cookie is set', () => {
    expect(applySessionCookies('a=b', ['NEXT_LOCALE=es; Path=/'])).toBeNull();
  });
});
