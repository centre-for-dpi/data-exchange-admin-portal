import { getToken } from 'next-auth/jwt';
import { headers } from 'next/headers';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem?: unknown,
  ) {
    super(`Portal API responded ${status}`);
  }
}

const apiUrl = (): string => process.env.RID_API_URL ?? 'http://localhost:4000';

/**
 * Calls apps/api from the server with the user's access token, read from the encrypted session
 * cookie. The token never reaches the browser. Responses are validated with the shared zod
 * contracts (packages/contracts).
 */
export async function apiGet<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  const token = await getToken({
    req: { headers: await headers() },
    secret: process.env.AUTH_SECRET ?? '',
    secureCookie: (process.env.AUTH_URL ?? '').startsWith('https://'),
  });
  const accessToken = token?.accessToken;
  if (typeof accessToken !== 'string') throw new ApiError(401);

  const res = await fetch(`${apiUrl()}/api/v1${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => undefined));
  return schema.parse(await res.json());
}
