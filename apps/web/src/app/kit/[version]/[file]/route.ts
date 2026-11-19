import { KIT_RELEASE_VERSION } from '@den/contracts';
import { forwardedForHeader } from '../../../../lib/client-ip';

const apiUrl = (): string => process.env.DEN_API_URL ?? 'http://localhost:4000';

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:tar\.gz|tgz)(?:\.sha256)?$/;

/** Headers of the API's answer that the download keeps. */
const KEPT = ['content-type', 'content-length', 'content-disposition', 'cache-control'] as const;

/**
 * The portal's mirror of the node kit (P-03): /kit/<version>/<bundle> and its `.sha256`, for
 * entities whose servers reach the portal but not GitHub. Anonymous, like the release itself:
 * nothing in it is secret (enrolling a node takes the token). The API serves the bytes it
 * checked against the release's SHA-256 on upload; a versioned path never changes, so it is
 * cached for good.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ version: string; file: string }> },
): Promise<Response> {
  const { version, file } = await params;
  if (!KIT_RELEASE_VERSION.test(version) || !FILE.test(file)) {
    return new Response(null, { status: 404 });
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/api/v1/kit/releases/${version}/${file}`, {
      cache: 'no-store',
      headers: await forwardedForHeader(),
    });
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!res.ok) {
    // Read the short problem body out: cancelling the stream left the answer hanging.
    await res.arrayBuffer().catch(() => undefined);
    return new Response(null, {
      status: res.status === 404 || res.status === 400 ? 404 : 502,
      headers: { 'cache-control': 'no-store' },
    });
  }
  const headers = new Headers({
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  for (const name of KEPT) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(res.body, { status: 200, headers });
}
