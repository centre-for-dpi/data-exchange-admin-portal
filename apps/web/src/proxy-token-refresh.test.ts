// M-21: the token the proxy refreshes reaches the browser (Set-Cookie) and also the render and the
// server actions of the same request, which read the request's cookie header.
import { beforeAll, describe, expect, it, vi } from 'vitest';

const SECRET = 'review-secret-0123456789abcdef0123456789abcdef';
const COOKIE = 'authjs.session-token';

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
  process.env.AUTH_URL = 'http://localhost:3000';
  process.env.AUTH_TRUST_HOST = 'true';
  process.env.DEN_PORTAL_WEB_CLIENT_SECRET = 'x';
  process.env.KEYCLOAK_URL = 'http://keycloak.test';
});

describe('token refresh in the proxy (M-21)', () => {
  it('hands the refreshed token to the browser and to the render of the same request', async () => {
    const { encode, decode } = await import('next-auth/jwt');
    const { NextRequest } = await import('next/server');
    const expired = await encode({
      secret: SECRET,
      salt: COOKIE,
      token: {
        sub: 'u1',
        name: 'Carlos',
        accessToken: 'OLD-EXPIRED',
        refreshToken: 'RT1',
        idToken: 'ID',
        expiresAt: Math.floor(Date.now() / 1000) - 600, // idle for 10 minutes past expiry
      },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { body?: unknown }) => {
        calls.push(init?.body instanceof URLSearchParams ? init.body.toString() : '');
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'NEW', expires_in: 300, refresh_token: 'RT2' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }),
    );
    const { default: proxy } = await import('./proxy');
    const request = new NextRequest('http://localhost:3000/catalog', {
      headers: { cookie: `${COOKIE}=${expired}` },
    });
    const response = await proxy(request, {} as never);
    expect(response).toBeTruthy();

    // 1. The refresh happened and the browser gets the new cookie.
    expect(calls.some((c) => c.includes('grant_type=refresh_token'))).toBe(true);
    const setCookie = response!.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
    expect(setCookie).toBeTruthy();
    const fresh = await decode({
      secret: SECRET,
      salt: COOKIE,
      token: decodeURIComponent(setCookie!.split(';')[0]!.slice(COOKIE.length + 1)),
    });
    expect(fresh?.accessToken).toBe('NEW');

    // 2. The render of this same request is handed the new cookie too: the forwarded request
    // headers carry it (how Next lets a proxy rewrite the request the app sees), so lib/api.ts
    // (getToken on headers()) decodes the new token, not the expired one the browser sent.
    expect(response!.headers.get('x-middleware-override-headers')).toContain('cookie');
    const forwarded = response!.headers.get('x-middleware-request-cookie') ?? '';
    expect(forwarded).not.toContain('OLD');
    const forwardedSession = forwarded
      .split('; ')
      .find((c) => c.startsWith(`${COOKIE}=`))!
      .slice(COOKIE.length + 1);
    const seenByRender = await decode({ secret: SECRET, salt: COOKIE, token: forwardedSession });
    expect(seenByRender?.accessToken).toBe('NEW');
  });
});
