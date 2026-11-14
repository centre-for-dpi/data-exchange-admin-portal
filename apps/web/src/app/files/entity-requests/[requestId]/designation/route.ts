import { ApiError, apiGetRaw } from '../../../../../lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Downloads the designation document of an onboarding request. The browser never holds the
 * access token, so the web server fetches the PDF from the API with the user's session; the API
 * decides who may read it (applicant and operator, 404 for anyone else).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await params;
  if (!UUID.test(requestId)) return new Response(null, { status: 404 });
  let res: Response;
  try {
    res = await apiGetRaw(`/entity-requests/${requestId}/designation-document`);
  } catch (error) {
    if (error instanceof ApiError) return new Response(null, { status: error.status });
    throw error;
  }
  if (!res.ok) return new Response(null, { status: res.status === 401 ? 401 : 404 });
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
