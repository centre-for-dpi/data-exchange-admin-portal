/** Session token fields kept in the encrypted Auth.js cookie (never sent to the browser). */
export interface SessionTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  /** Access token expiry, epoch seconds. */
  expiresAt?: number;
  error?: 'RefreshTokenError';
}

/** Refresh this many seconds before the access token (5 min in den-portal) expires. */
export const REFRESH_BEFORE_SECONDS = Number(process.env.DEN_AUTH_REFRESH_BEFORE_SECONDS ?? 60);

export const needsRefresh = (tokens: SessionTokens, nowSeconds = Date.now() / 1000): boolean =>
  tokens.expiresAt === undefined || nowSeconds >= tokens.expiresAt - REFRESH_BEFORE_SECONDS;

/**
 * Exchanges the refresh token at Keycloak's token endpoint. On failure the session is marked with
 * an error and the user has to sign in again; tokens are never logged.
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
    if (!res.ok) return { ...tokens, error: 'RefreshTokenError' };
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      id_token?: string;
    };
    return {
      accessToken: body.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + body.expires_in,
      refreshToken: body.refresh_token ?? tokens.refreshToken,
      idToken: body.id_token ?? tokens.idToken,
    };
  } catch {
    return { ...tokens, error: 'RefreshTokenError' };
  }
}
