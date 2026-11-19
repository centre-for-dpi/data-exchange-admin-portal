/** Session token fields kept in the encrypted Auth.js cookie (never sent to the browser). */
export interface SessionTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  /** Access token expiry, epoch seconds. */
  expiresAt?: number;
  /**
   * When Keycloak last saw this session, epoch seconds: the sign-in or the last refresh. An SSO
   * session ends `ssoSessionIdleTimeout` after it, so it is what the session-end notice counts from.
   */
  refreshedAt?: number;
  error?: 'RefreshTokenError';
}

/** Seconds left before Keycloak ends the session for inactivity, as of `nowSeconds`. */
export const idleSecondsLeft = (
  refreshedAt: number | undefined,
  idleSeconds: number,
  nowSeconds = Date.now() / 1000,
): number => Math.max(0, Math.floor((refreshedAt ?? nowSeconds) + idleSeconds - nowSeconds));

/** Refresh this many seconds before the access token (5 min in den-portal) expires. */
export const REFRESH_BEFORE_SECONDS = Number(process.env.DEN_AUTH_REFRESH_BEFORE_SECONDS ?? 60);

export const needsRefresh = (tokens: SessionTokens, nowSeconds = Date.now() / 1000): boolean =>
  tokens.expiresAt === undefined || nowSeconds >= tokens.expiresAt - REFRESH_BEFORE_SECONDS;

/**
 * Exchanges the refresh token at Keycloak's token endpoint. When Keycloak rejects the refresh
 * token (or there is none) the session is marked with an error and the user has to sign in again
 * (B-25); tokens are never logged. A failure to reach Keycloak, or an answer of its own that is
 * not a rejection (5xx), is temporary: the tokens are returned unchanged and the next request tries
 * again, instead of signing everyone out while Keycloak restarts.
 */
export async function refreshTokens(
  tokens: SessionTokens,
  options: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    fetchFn?: typeof fetch;
  },
): Promise<SessionTokens> {
  if (!tokens.refreshToken) return { ...tokens, error: 'RefreshTokenError' };
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const res = await fetchFn(options.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ...tokens, error: 'RefreshTokenError' };
    }
    if (!res.ok) return tokens;
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      id_token?: string;
    };
    return {
      accessToken: body.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + body.expires_in,
      refreshedAt: Math.floor(Date.now() / 1000),
      refreshToken: body.refresh_token ?? tokens.refreshToken,
      idToken: body.id_token ?? tokens.idToken,
    };
  } catch {
    return tokens;
  }
}
