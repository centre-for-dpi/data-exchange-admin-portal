import { describe, expect, it } from 'vitest';
import { needsRefresh, refreshTokens } from './token-refresh';

const options = (fetchFn: typeof fetch) => ({
  tokenEndpoint: 'https://kc/token',
  clientId: 'den-portal-web',
  clientSecret: 's',
  fetchFn,
});

const response = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('session token refresh', () => {
  it('refreshes shortly before expiry', () => {
    const now = 1_000_000;
    expect(needsRefresh({ expiresAt: now + 300 }, now)).toBe(false);
    expect(needsRefresh({ expiresAt: now + 30 }, now)).toBe(true);
    expect(needsRefresh({}, now)).toBe(true);
  });

  it('stores the new tokens and keeps the old refresh token if none is returned', async () => {
    let sent = '';
    const fetchFn = ((_url: string, init: RequestInit) => {
      sent = (init.body as URLSearchParams).toString();
      return response(200, { access_token: 'new-access', expires_in: 300 });
    }) as typeof fetch;
    const result = await refreshTokens(
      { accessToken: 'old', refreshToken: 'refresh-1', idToken: 'id-1', expiresAt: 0 },
      options(fetchFn),
    );
    expect(sent).toContain('grant_type=refresh_token');
    expect(sent).toContain('refresh_token=refresh-1');
    expect(result).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'refresh-1',
      idToken: 'id-1',
    });
    expect(result.error).toBeUndefined();
  });

  it('marks the session as failed when Keycloak rejects the refresh token', async () => {
    const result = await refreshTokens(
      { refreshToken: 'expired' },
      options(() => response(400, { error: 'invalid_grant' })),
    );
    expect(result.error).toBe('RefreshTokenError');
  });

  it('records when the session was refreshed', async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await refreshTokens(
      { refreshToken: 'r' },
      options(() => response(200, { access_token: 'a', expires_in: 300 })),
    );
    expect(result.refreshedAt).toBeGreaterThanOrEqual(before);
  });

  it('keeps the session when Keycloak cannot be reached: the next request tries again', async () => {
    const down = (() => Promise.reject(new Error('down'))) as typeof fetch;
    expect(await refreshTokens({ refreshToken: 'r', expiresAt: 1 }, options(down))).toEqual({
      refreshToken: 'r',
      expiresAt: 1,
    });
    const unavailable = await refreshTokens(
      { refreshToken: 'r' },
      options(() => response(503, {})),
    );
    expect(unavailable.error).toBeUndefined();
  });

  it('marks the session as failed when there is no refresh token', async () => {
    expect(
      (
        await refreshTokens(
          {},
          options(() => response(200, {})),
        )
      ).error,
    ).toBe('RefreshTokenError');
  });
});
