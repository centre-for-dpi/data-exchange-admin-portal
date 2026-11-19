import { getToken } from 'next-auth/jwt';
import { headers as requestHeaders } from 'next/headers';
import { unstable_update } from '../../../../auth';
import { sessionIdleSeconds } from '../../../../lib/session-idle';
import { idleSecondsLeft } from '../../../../lib/token-refresh';

/**
 * How long the session has left before Keycloak ends it for inactivity, from the session cookie
 * alone: it refreshes nothing, so it can be asked as often as needed (B-25).
 */
export async function GET(): Promise<Response> {
  const token = await getToken({
    req: { headers: await requestHeaders() },
    secret: process.env.AUTH_SECRET ?? '',
    secureCookie: (process.env.AUTH_URL ?? '').startsWith('https://'),
  });
  const headers = { 'cache-control': 'no-store' };
  if (!token) return new Response(null, { status: 401, headers });
  const refreshedAt = typeof token.refreshedAt === 'number' ? token.refreshedAt : undefined;
  return Response.json(
    { remainingSeconds: idleSecondsLeft(refreshedAt, sessionIdleSeconds()) },
    { headers },
  );
}

/**
 * "Stay signed in" (B-25): refreshes the tokens with Keycloak right now, which is what restarts
 * the idle count of its session, and answers how long the session has left. 401 when there is no
 * session, or when Keycloak no longer accepts it (the session cookie is deleted in that case).
 */
export async function POST(): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  const session = await unstable_update({});
  if (!session?.user) return new Response(null, { status: 401, headers });
  return Response.json(
    { remainingSeconds: idleSecondsLeft(session.refreshedAt, sessionIdleSeconds()) },
    { headers },
  );
}
