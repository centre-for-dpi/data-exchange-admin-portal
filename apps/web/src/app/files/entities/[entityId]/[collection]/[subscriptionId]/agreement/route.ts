import { ApiError, apiGetRaw } from '../../../../../../../lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLLECTIONS = new Set(['subscriptions', 'access-requests']);

/**
 * Downloads the exchange agreement of an access request (M2-07), as the requesting entity
 * (subscriptions) or the provider (access-requests). The web server fetches it with the user's
 * session; the API decides who may read it (404 for anyone else, 410 after a legal deletion).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entityId: string; collection: string; subscriptionId: string }> },
): Promise<Response> {
  const { entityId, collection, subscriptionId } = await params;
  if (!UUID.test(entityId) || !UUID.test(subscriptionId) || !COLLECTIONS.has(collection)) {
    return new Response(null, { status: 404 });
  }
  let res: Response;
  try {
    res = await apiGetRaw(`/entities/${entityId}/${collection}/${subscriptionId}/agreement`);
  } catch (error) {
    if (error instanceof ApiError) return new Response(null, { status: error.status });
    throw error;
  }
  if (!res.ok) {
    return new Response(null, { status: [401, 410].includes(res.status) ? res.status : 404 });
  }
  const headers = new Headers({
    'content-type': 'application/pdf',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'no-store',
  });
  const disposition = res.headers.get('content-disposition');
  if (disposition) headers.set('content-disposition', disposition);
  return new Response(res.body, { status: 200, headers });
}
