import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { getCountryConfig } from '@rid/config';

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * The model exchange agreement of the country config (documents.agreementTemplate, M2-07). Not
 * a secret: anyone preparing a request can start from it.
 */
export async function GET(): Promise<Response> {
  const file = getCountryConfig().documents.agreementTemplate;
  const type = file ? CONTENT_TYPES[extname(file).toLowerCase()] : undefined;
  if (!file || !type) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(await readFile(file)), {
    headers: {
      'content-type': type,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=3600',
    },
  });
}
