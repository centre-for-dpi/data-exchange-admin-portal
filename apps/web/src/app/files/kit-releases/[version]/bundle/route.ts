import { KIT_BUNDLE_MEDIA_TYPE, KIT_RELEASE_VERSION } from '@den/contracts';
import { ApiError, apiPutStream } from '../../../../../lib/api';

/** The portal's own origin: AUTH_URL behind the proxy, else the request's. */
const ownOrigin = (request: Request): string => new URL(process.env.AUTH_URL ?? request.url).origin;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * The operator uploads a release's bundle to the portal's mirror (P-03). The browser never holds
 * the access token, so this route streams the file to the API with the session's token; the API
 * decides who may (platform_admin) and accepts only the bytes of the release. A server action
 * would buffer the whole bundle within its body limit. Same-origin only: the session cookie is
 * SameSite=Lax, and the Origin header must be the portal's.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
): Promise<Response> {
  const { version } = await params;
  if (request.headers.get('origin') !== ownOrigin(request)) return json(403);
  if (!KIT_RELEASE_VERSION.test(version)) return json(404);
  if (request.headers.get('content-type') !== KIT_BUNDLE_MEDIA_TYPE || !request.body) {
    return json(415);
  }
  let res: Response;
  try {
    res = await apiPutStream(
      `/admin/kit-releases/${version}/bundle`,
      request.body,
      KIT_BUNDLE_MEDIA_TYPE,
    );
  } catch (error) {
    if (error instanceof ApiError) return json(error.status);
    return json(502);
  }
  if (res.ok) {
    // Read the short JSON body out: cancelling the stream left the answer hanging.
    await res.arrayBuffer().catch(() => undefined);
    return json(200, { ok: true });
  }
  // The problem's field errors carry the keys the form words in the user's language.
  const problem: unknown = await res.json().catch(() => undefined);
  return json(res.status, problem);
}
