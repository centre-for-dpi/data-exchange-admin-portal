import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { getSite } from '../../../lib/site';

const CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Serves the logo configured in config/country/<code>.yaml (branding.logo). */
export async function GET(): Promise<Response> {
  const file = getSite().logoFile;
  const type = CONTENT_TYPES[extname(file).toLowerCase()];
  if (!type) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(await readFile(file)), {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      // An SVG opened directly must not run scripts.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
