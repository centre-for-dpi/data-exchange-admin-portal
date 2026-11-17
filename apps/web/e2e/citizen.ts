import { createHash, randomBytes, randomUUID } from 'node:crypto';

const keycloak = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const api = process.env.DEN_API_URL ?? 'http://localhost:4000';

/**
 * Logs a citizen in to the reference Carpeta (realm den-citizens, client citizen-app) with
 * Authorization Code + PKCE, submitting Keycloak's login form as a browser would, and returns the
 * access token. The Carpeta itself (MT-07) does not need to run: the code is taken from the
 * redirect.
 */
export async function citizenToken(username: string): Promise<string> {
  const realm = `${keycloak}/realms/den-citizens/protocol/openid-connect`;
  const redirectUri = `${process.env.DEN_CITIZEN_APP_URL ?? 'http://localhost:3100'}/auth/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: 'citizen-app',
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const cookies = new Map<string, string>();
  const keep = (res: Response) => {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const page = await fetch(`${realm}/auth?${params.toString()}`, { redirect: 'manual' });
  keep(page);
  const action = /<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/.exec(await page.text())?.[1];
  if (!action) throw new Error('Keycloak did not show the login form');
  const submitted = await fetch(action.replaceAll('&amp;', '&'), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: new URLSearchParams({
      username,
      password: process.env.DEN_DEMO_USER_PASSWORD ?? 'demo',
      credentialId: '',
    }),
  });
  const code = new URL(submitted.headers.get('location') ?? 'about:blank').searchParams.get('code');
  if (!code) throw new Error('Citizen login failed');
  const secret = process.env.DEN_CITIZEN_APP_CLIENT_SECRET ?? '';
  const tokens = await fetch(`${realm}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`citizen-app:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokens.ok) throw new Error(`Token exchange failed: ${tokens.status}`);
  return ((await tokens.json()) as { access_token: string }).access_token;
}

export interface CitizenAccess {
  id: string;
  occurredAt: string;
  api: { name: string } | null;
  operation: { id: string };
  status: number;
  sealed: boolean;
}

/** The citizen's consultations through the portal API, all pages. */
export async function myAccesses(token: string): Promise<CitizenAccess[]> {
  const items: CitizenAccess[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const query: string = cursor ? `?limit=100&cursor=${cursor}` : '?limit=100';
    const res = await fetch(`${api}/api/v1/data-subjects/me/accesses${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`accesses: HTTP ${res.status}`);
    const page = (await res.json()) as { items: CitizenAccess[]; nextCursor: string | null };
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return items;
}

/** The reference citizen folder (infra/mock-citizen-app, MT-07). */
export const carpeta = process.env.DEN_CITIZEN_APP_URL ?? 'http://localhost:3100';
const mailpit = `http://localhost:${process.env.MAILPIT_UI_PORT ?? '8025'}/api/v1`;

/** Messages Mailpit received for an address. */
export async function mailsTo(address: string): Promise<Array<{ ID: string; Subject: string }>> {
  const res = await fetch(`${mailpit}/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  if (!res.ok) throw new Error(`mailpit: HTTP ${res.status}`);
  return ((await res.json()) as { messages: Array<{ ID: string; Subject: string }> }).messages;
}

export async function mailText(id: string): Promise<string> {
  const res = await fetch(`${mailpit}/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}
