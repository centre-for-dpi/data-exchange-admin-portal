import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from './env.js';

export const keycloakUrl = (): string => env('KEYCLOAK_URL', 'http://localhost:8080');
export const webUrl = (): string => env('RID_WEB_URL', 'http://localhost:3000');

export type JwtClaims = Record<string, unknown> & {
  iss: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp: number;
  iat: number;
};

/** Decodes a JWT payload without verifying it (tests only inspect claims Keycloak just issued). */
export function decodeJwt(token: string): JwtClaims {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
}

export const audiences = (claims: JwtClaims): string[] =>
  claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];

const basicAuth = (id: string, secret: string): string =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

export async function clientCredentialsToken(
  realm: string,
  clientId: string,
  clientSecret: string,
): Promise<Response> {
  return fetch(`${keycloakUrl()}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(clientId, clientSecret),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
}

/** Minimal cookie jar: enough to carry Keycloak's login session between requests. */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(res: Response): void {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (pair && index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export interface AuthorizationCodeResult {
  /** Final redirect back to the web app, or undefined if Keycloak did not redirect. */
  redirect?: URL;
  /** HTML of the last page when Keycloak answered with a page instead of a redirect. */
  page?: string;
  tokens?: { access_token: string; id_token: string };
}

/**
 * Runs the browser login of apps/web (Authorization Code + PKCE S256) against realm rid-portal,
 * submitting Keycloak's login form like a user would.
 */
export async function loginWithAuthorizationCode(
  username: string,
  password: string,
  options: { pkce?: boolean; redirectUri?: string } = {},
): Promise<AuthorizationCodeResult> {
  const realmUrl = `${keycloakUrl()}/realms/rid-portal/protocol/openid-connect`;
  const redirectUri = options.redirectUri ?? `${webUrl()}/api/auth/callback/keycloak`;
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: env('RID_PORTAL_WEB_CLIENT_ID', 'rid-portal-web'),
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state: randomUUID(),
  });
  if (options.pkce !== false) {
    params.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    params.set('code_challenge_method', 'S256');
  }

  const jar = new CookieJar();
  const loginPage = await fetch(`${realmUrl}/auth?${params.toString()}`, { redirect: 'manual' });
  jar.store(loginPage);
  if (loginPage.status >= 300 && loginPage.status < 400) {
    return { redirect: new URL(loginPage.headers.get('location') ?? '') };
  }
  const html = await loginPage.text();
  const action = /<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/.exec(html)?.[1];
  if (!action) return { page: html };

  const submitted = await fetch(action.replaceAll('&amp;', '&'), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  const location = submitted.headers.get('location');
  if (!location) return { page: await submitted.text() };

  const redirect = new URL(location);
  const code = redirect.searchParams.get('code');
  if (!code) return { redirect };

  const tokenRes = await fetch(`${realmUrl}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(
        env('RID_PORTAL_WEB_CLIENT_ID', 'rid-portal-web'),
        env('RID_PORTAL_WEB_CLIENT_SECRET'),
      ),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
  return { redirect, tokens: (await tokenRes.json()) as AuthorizationCodeResult['tokens'] };
}
