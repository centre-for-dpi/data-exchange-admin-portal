import { ApiError, apiGetRaw } from '../../../../lib/api';

/** Query keys passed through to the API export (its zod schema validates them again). */
const KEYS = ['format', 'action', 'targetType', 'targetId', 'entityId', 'actorId', 'from', 'to'];
const PASSED_HEADERS = [
  'content-type',
  'content-disposition',
  'digest',
  'x-den-export-sha256',
  'x-den-export-count',
  'x-den-export-signature',
];

/**
 * Signed export of the audit trail (M2-09), through the web server with the user's session. The
 * API decides who may export (operator, regulator, auditors) and audits each export.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = new URLSearchParams();
  for (const key of KEYS) {
    const value = url.searchParams.get(key);
    if (value) query.set(key, value);
  }
  let res: Response;
  try {
    res = await apiGetRaw(`/audit/export?${query.toString()}`);
  } catch (error) {
    if (error instanceof ApiError) return new Response(null, { status: error.status });
    throw error;
  }
  if (!res.ok)
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/problem+json' },
    });
  const headers = new Headers({ 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  for (const name of PASSED_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(res.body, { status: 200, headers });
}
