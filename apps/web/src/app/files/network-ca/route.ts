import { PEM_CHAIN_MEDIA_TYPE } from '@den/contracts';

const apiUrl = (): string => process.env.DEN_API_URL ?? 'http://localhost:4000';

/**
 * The root of the network CA (M3-10), public: applications trust the gateway's certificate with
 * it. Served from the portal's origin so the guide can link it.
 */
export async function GET(): Promise<Response> {
  const res = await fetch(`${apiUrl()}/api/v1/pki/ca`, { cache: 'no-store' });
  if (!res.ok) return new Response(null, { status: res.status === 503 ? 503 : 502 });
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': PEM_CHAIN_MEDIA_TYPE,
      'content-disposition': 'attachment; filename="den-network-ca.pem"',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=3600',
    },
  });
}
