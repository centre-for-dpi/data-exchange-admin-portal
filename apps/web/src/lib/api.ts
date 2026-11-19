import { getToken } from 'next-auth/jwt';
import { headers } from 'next/headers';
import type { z } from 'zod';
import { isMfaRequired, redirectToStepUp } from './step-up';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem?: unknown,
  ) {
    super(`Portal API responded ${status}`);
  }
}

const apiUrl = (): string => process.env.DEN_API_URL ?? 'http://localhost:4000';

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
  if (!res.ok) {
    const problem: unknown = await res.json().catch(() => undefined);
    // The session lacks the second factor its roles need (M3-08): sign in again with it.
    if (res.status === 403 && isMfaRequired(problem)) await redirectToStepUp();
    throw new ApiError(res.status, problem);
  }
  return schema.parse(await res.json());
}

/** Most pages apiGetAll follows; lists are per entity, so this is a safety cap, not a limit. */
const MAX_PAGES = 50;

/**
 * Reads every page of a cursor-paginated list (`?cursor=&limit=`, ARCHITECTURE conventions) and
 * returns them as one page. For screens that show or offer the whole list (an entity's
 * applications, APIs, requests); a single page would silently hide the newest items.
 */
export async function apiGetAll<
  S extends z.ZodType<{ items: unknown[]; nextCursor: string | null }>,
>(path: string, schema: S): Promise<z.output<S>> {
  const separator = path.includes('?') ? '&' : '?';
  const first = await apiGet(`${path}${separator}limit=100`, schema);
  const items = [...first.items];
  let cursor = first.nextCursor;
  for (let pages = 1; cursor && pages < MAX_PAGES; pages++) {
    const next = await apiGet(
      `${path}${separator}limit=100&cursor=${encodeURIComponent(cursor)}`,
      schema,
    );
    items.push(...next.items);
    cursor = next.nextCursor;
  }
  return { ...first, items, nextCursor: null };
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; problem?: Problem };

/** Problem details as returned by the portal API (RFC 9457). */
export interface Problem {
  code?: string;
  title?: string;
  detail?: string;
  /** Field errors; `key` and `params` let the portal word them in the user's language. */
  errors?: Array<{ path: string; message: string; key?: string; params?: Record<string, unknown> }>;
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
  // 204 No Content: pass `z.undefined()` as the schema.
  return { ok: true, data: schema.parse(res.status === 204 ? undefined : await res.json()) };
}

/** Sends a binary body (a PDF document) with PUT; same error handling as apiSend. */
export async function apiPutBytes<S extends z.ZodType>(
  path: string,
  bytes: ArrayBuffer,
  contentType: string,
  schema: S,
): Promise<ApiResult<z.output<S>>> {
  const res = await fetch(`${apiUrl()}/api/v1${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      accept: 'application/json',
      'content-type': contentType,
    },
    body: bytes,
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

/**
 * PUT streaming a request body to the API with the user's token (the kit's bundle, P-03): the
 * web server never holds the whole file. Returns the raw response.
 */
export async function apiPutStream(
  path: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<Response> {
  return fetch(`${apiUrl()}/api/v1${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      accept: 'application/json',
      'content-type': contentType,
    },
    body,
    // Node's fetch streams a request body only half-duplex.
    duplex: 'half',
    cache: 'no-store',
  } as RequestInit & { duplex: 'half' });
}

/** GET returning the raw response (downloads), with the user's token. */
export async function apiGetRaw(path: string): Promise<Response> {
  return fetch(`${apiUrl()}/api/v1${path}`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
    cache: 'no-store',
  });
}
