import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinnedGet } from './pinned-get.js';

describe('pinnedGet (MB-2): the connection goes to the vetted address', () => {
  let server: http.Server;
  let port = 0;
  let seenHost = '';
  let body: () => string = () => 'ok';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenHost = String(req.headers.host);
      const text = body();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(text);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const options = { maxBytes: 64, timeoutMs: 3000, allowHttp: true };
  const target = () => new URL(`http://rebinding.example:${port}/.well-known/den-validation`);

  it('resolves once, connects to that address and keeps the original Host', async () => {
    let resolutions = 0;
    const result = await pinnedGet(target(), {
      ...options,
      allowed: () => true,
      // A rebinding resolver: the second answer would be another address. It is never asked.
      resolve: () => {
        resolutions += 1;
        return Promise.resolve([
          resolutions === 1
            ? { address: '127.0.0.1', family: 4 }
            : { address: '10.0.0.1', family: 4 },
        ]);
      },
    });
    expect(result).toEqual({ ok: true, status: 200, body: 'ok' });
    expect(resolutions).toBe(1);
    expect(seenHost).toBe(`rebinding.example:${port}`);
  });

  it('refuses a name that resolves to an address that is not public, any of them', async () => {
    const mixed = await pinnedGet(target(), {
      ...options,
      resolve: () =>
        Promise.resolve([
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
    });
    expect(mixed).toEqual({ ok: false, reason: 'not_public' });
    const internal = await pinnedGet(target(), {
      ...options,
      resolve: () => Promise.resolve([{ address: '169.254.169.254', family: 4 }]),
    });
    expect(internal).toEqual({ ok: false, reason: 'not_public' });
  });

  it('stops reading a body beyond the limit', async () => {
    body = () => 'x'.repeat(10_000);
    const result = await pinnedGet(target(), {
      ...options,
      allowed: () => true,
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    body = () => 'ok';
  });

  it('does not accept http:// unless a test allows it', async () => {
    const result = await pinnedGet(target(), {
      maxBytes: 64,
      timeoutMs: 1000,
      allowed: () => true,
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(result.ok).toBe(false);
  });
});
