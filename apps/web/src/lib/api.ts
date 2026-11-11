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
async function accessToken(): Promise<string> {
  const token = await getToken({
    req: { headers: await headers() },
    secret: process.env.AUTH_SECRET ?? '',
    secureCookie: (process.env.AUTH_URL ?? '').startsWith('https://'),
  });
  if (typeof token?.accessToken !== 'string') throw new ApiError(401);
  return token.accessToken;
}

export async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { anonymous?: boolean } = {},
): Promise<z.output<S>> {
  // anonymous: call without a token (public catalogue); otherwise the user's token is required.
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!options.anonymous) headers.authorization = `Bearer ${await accessToken()}`;
  const url = `${apiUrl()}/api/v1${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers, cache: 'no-store' });
  } catch {
    // GETs are idempotent: retry once on a network error (e.g. ECONNRESET when a keep-alive
    // connection is closed by the API at the moment it is reused).
    res = await fetch(url, { headers, cache: 'no-store' });
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => undefined));
  return schema.parse(await res.json());
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; problem?: Problem };

/** Problem details as returned by the portal API (RFC 9457). */
export interface Problem {
  code?: string;
  title?: string;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}

/** Writes to the API. Errors are returned (not thrown) so forms can show them next to fields. */
export async function apiSend<S extends z.ZodType>(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  schema: S,
): Promise<ApiResult<z.output<S>>> {
  const res = await fetch(`${apiUrl()}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      problem: (await res.json().catch(() => undefined)) as Problem,
    };
  }
  return { ok: true, data: schema.parse(await res.json()) };
}
