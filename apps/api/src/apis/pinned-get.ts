import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPublicAddress } from '@den/contracts';

export interface PinnedGetOptions {
  /** Bytes read from the body at most; the rest is never read (the connection is dropped). */
  maxBytes: number;
  /** Whole request, connection and body included. */
  timeoutMs: number;
  /** Resolves a name; injectable for tests. */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Which addresses may be called; defaults to publicly routable ones. */
  allowed?: (address: string) => boolean;
  /** Tests only: http:// URLs. */
  allowHttp?: boolean;
}

export type PinnedGetResult =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: 'not_public' | 'unresolved' | 'too_large' | 'error' };

/**
 * GET against a host a provider named (the portal's own request, from its own network): the name
 * is resolved once, every address must be allowed, and the connection goes to exactly that vetted
 * address (the socket's lookup returns it), keeping Host and SNI as the original name, so a DNS
 * answer that changes between the check and the connection (rebinding) cannot reach another
 * address. No redirects; a declared or actual body beyond `maxBytes` ends the request.
 */
export async function pinnedGet(target: URL, options: PinnedGetOptions): Promise<PinnedGetResult> {
  const { maxBytes, timeoutMs } = options;
  const allowed = options.allowed ?? isPublicAddress;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (options.resolve ?? ((h) => dnsLookup(h, { all: true })))(
      target.hostname.replace(/^\[|\]$/g, ''),
    );
  } catch {
    return { ok: false, reason: 'unresolved' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'unresolved' };
  if (!addresses.every((a) => allowed(a.address))) return { ok: false, reason: 'not_public' };
  const pinned = addresses[0]!;

  const transport = target.protocol === 'http:' && options.allowHttp ? http : https;
  if (transport === https && target.protocol !== 'https:') return { ok: false, reason: 'error' };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PinnedGetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { accept: 'text/plain', 'user-agent': 'den-portal-host-control' },
        servername: target.hostname.replace(/^\[|\]$/g, ''),
        // The vetted address, whatever the name resolves to now.
        lookup: (_host, lookupOptions, callback) => {
          const entry = { address: pinned.address, family: pinned.family };
          if ((lookupOptions as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: (typeof entry)[]) => void)(null, [entry]);
          } else {
            callback(null, entry.address, entry.family);
          }
        },
      },
      (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          finish({ ok: false, reason: 'too_large' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            finish({ ok: false, reason: 'too_large' });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish({
            ok: true,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () => finish({ ok: false, reason: 'error' }));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, reason: 'error' });
    }, timeoutMs);
    req.on('error', () => finish({ ok: false, reason: 'error' }));
    req.end();
  });
}
