import { entityCheckScript } from '../../../lib/entity-check-script';

// Made when the web is built, from the repository's scripts/entity-check.sh.
export const dynamic = 'force-static';

/**
 * `scripts/entity-check.sh` for download (P-05), public like the guides that use it: the
 * application page offers it next to the CSR commands, and its `csr` subcommand does what they do.
 */
export function GET(): Response {
  return new Response(entityCheckScript(), {
    status: 200,
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'content-disposition': 'attachment; filename="entity-check.sh"',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'public, max-age=3600',
    },
  });
}
