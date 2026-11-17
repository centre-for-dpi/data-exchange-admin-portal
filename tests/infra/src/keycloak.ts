import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { env } from './env.js';

export const keycloakUrl = (): string => env('KEYCLOAK_URL', 'http://localhost:8080');
export const webUrl = (): string => env('DEN_WEB_URL', 'http://localhost:3000');

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
export class CookieJar {
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

/** RFC 6238 TOTP like the den-portal OTP policy: 6 digits, 30 s, HMAC-SHA1, UTF-8 key (M3-08). */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const demoTotpSecret = (): string => env('DEN_DEMO_TOTP_SECRET', 'den-demo-totp-secret');

export interface AuthorizationCodeResult {
  /** Final redirect back to the web app, or undefined if Keycloak did not redirect. */
  redirect?: URL;
  /** HTML of the last page when Keycloak answered with a page instead of a redirect. */
  page?: string;
  tokens?: { access_token: string; id_token: string; refresh_token: string };
  /** Ids of the forms Keycloak showed, in order (kc-form-login, kc-otp-login-form...). */
  forms: string[];
}

/**
 * Runs the browser login of apps/web (Authorization Code + PKCE S256) against realm den-portal,
 * submitting Keycloak's login form like a user would.
 */
export interface LoginClient {
  realm: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** apps/web in realm den-portal. */
export const portalWebClient = (): LoginClient => ({
  realm: 'den-portal',
  clientId: env('DEN_PORTAL_WEB_CLIENT_ID', 'den-portal-web'),
  clientSecret: env('DEN_PORTAL_WEB_CLIENT_SECRET'),
  redirectUri: `${webUrl()}/api/auth/callback/keycloak`,
});

/** The reference Carpeta Ciudadana in realm den-citizens (MT-05, MT-07). */
export const citizenAppClient = (): LoginClient => ({
  realm: 'den-citizens',
  clientId: 'citizen-app',
  clientSecret: env('DEN_CITIZEN_APP_CLIENT_SECRET'),
  redirectUri: `${env('DEN_CITIZEN_APP_URL', 'http://localhost:3100')}/auth/callback`,
});

export async function loginWithAuthorizationCode(
  username: string,
  password: string,
  options: {
    pkce?: boolean;
    redirectUri?: string;
    client?: LoginClient;
    /** acr_values of the request: 'mfa' asks for the second factor (M3-08). */
    acr?: string;
    /** The one-time code to type if Keycloak asks for it. */
    otp?: string;
    /** Keycloak's session from an earlier login, to step it up. */
    jar?: CookieJar;
  } = {},
): Promise<AuthorizationCodeResult> {
  const client = options.client ?? portalWebClient();
  const realmUrl = `${keycloakUrl()}/realms/${client.realm}/protocol/openid-connect`;
  const redirectUri = options.redirectUri ?? client.redirectUri;
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: client.clientId,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state: randomUUID(),
  });
  if (options.pkce !== false) {
    params.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    params.set('code_challenge_method', 'S256');
  }
  if (options.acr) params.set('acr_values', options.acr);

  const jar = options.jar ?? new CookieJar();
  const forms: string[] = [];
  let res = await fetch(`${realmUrl}/auth?${params.toString()}`, {
    redirect: 'manual',
    headers: { cookie: jar.header() },
  });
  jar.store(res);
  // Each Keycloak page is a form: the password, then the one-time code when asked for.
  for (let step = 0; step < 3 && !res.headers.get('location'); step += 1) {
    const html = await res.text();
    const form = /<form[^>]+id="([^"]+)"[^>]+action="([^"]+)"/.exec(html);
    const body: Record<string, string> | undefined =
      form?.[1] === 'kc-form-login' && !forms.includes('kc-form-login')
        ? { username, password, credentialId: '' }
        : form?.[1] === 'kc-otp-login-form' && options.otp && !forms.includes('kc-otp-login-form')
          ? { otp: options.otp }
          : undefined;
    if (!form?.[2] || !body) return { page: html, forms };
    forms.push(form[1] ?? '');
    res = await fetch(form[2].replaceAll('&amp;', '&'), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams(body),
    });
    jar.store(res);
  }
  const location = res.headers.get('location');
  if (!location) return { page: await res.text(), forms };

  const redirect = new URL(location);
  const code = redirect.searchParams.get('code');
  if (!code) return { redirect, forms };

  const tokenRes = await fetch(`${realmUrl}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(client.clientId, client.clientSecret),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
  return { redirect, tokens: (await tokenRes.json()) as AuthorizationCodeResult['tokens'], forms };
}
