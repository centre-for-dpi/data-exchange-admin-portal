import { PEM_CHAIN_MEDIA_TYPE } from '@den/contracts';
import { ApiError, apiGetRaw } from '../../../../../../../../../lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Downloads the client certificate of an application with its issuing chain (M3-01). The web
 * server fetches it with the user's session; the API decides who may read it (404 otherwise).
 */
export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ entityId: string; applicationId: string; credentialId: string }> },
): Promise<Response> {
  const { entityId, applicationId, credentialId } = await params;
  if (![entityId, applicationId, credentialId].every((id) => UUID.test(id))) {
    return new Response(null, { status: 404 });
  }
  let res: Response;
  try {
    res = await apiGetRaw(
      `/entities/${entityId}/applications/${applicationId}/credentials/${credentialId}/certificate`,
    );
  } catch (error) {
    if (error instanceof ApiError) return new Response(null, { status: error.status });
    throw error;
  }
  if (!res.ok) return new Response(null, { status: res.status === 401 ? 401 : 404 });
  const headers = new Headers({
    'content-type': PEM_CHAIN_MEDIA_TYPE,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'no-store',
  });
  const disposition = res.headers.get('content-disposition');
  if (disposition) headers.set('content-disposition', disposition);
  return new Response(res.body, { status: 200, headers });
}
