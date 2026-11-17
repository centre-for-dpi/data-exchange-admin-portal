import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AntivirusUnavailableError, ClamdScanner } from './antivirus.js';

/** A clamd that reads an INSTREAM and answers with `reply(bytes)`. */
async function fakeClamd(reply: (bytes: Buffer) => string | null) {
  const received: Buffer[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    let buffer = Buffer.alloc(0);
    let command = false;
    const body: Buffer[] = [];
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!command) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        expect(buffer.subarray(0, end).toString()).toBe('zINSTREAM');
        buffer = buffer.subarray(end + 1);
        command = true;
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const bytes = Buffer.concat(body);
          received.push(bytes);
          const answer = reply(bytes);
          if (answer === null) return; // never answers
          socket.end(`${answer}\0`);
          return;
        }
        if (buffer.length < 4 + size) return;
        body.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return { server, port, received, close };
}

describe('ClamdScanner (M6-08)', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });
  const start = async (reply: (bytes: Buffer) => string | null) => {
    const fake = await fakeClamd(reply);
    open.push(fake.close);
    return fake;
  };

  it('streams the whole document in chunks and reads a clean verdict', async () => {
    const fake = await start(() => 'stream: OK');
    const bytes = Buffer.alloc(200_000, 7);
    expect(await new ClamdScanner('127.0.0.1', fake.port).scan(bytes)).toEqual({ clean: true });
    expect(fake.received[0]?.equals(bytes)).toBe(true);
  });

  it('reports the signature of an infected document', async () => {
    const fake = await start(() => 'stream: Eicar-Test-Signature FOUND');
    expect(await new ClamdScanner('127.0.0.1', fake.port).scan(Buffer.from('x'))).toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
  });

  it('fails closed on an error reply, a closed port or no answer', async () => {
    const error = await start(() => 'INSTREAM size limit exceeded. ERROR');
    await expect(new ClamdScanner('127.0.0.1', error.port).scan(Buffer.from('x'))).rejects.toThrow(
      AntivirusUnavailableError,
    );
    const closed = await start(() => 'stream: OK');
    await closed.close();
    open.pop();
    await expect(new ClamdScanner('127.0.0.1', closed.port).scan(Buffer.from('x'))).rejects.toThrow(
      AntivirusUnavailableError,
    );
    const silent = await start(() => null);
    await expect(
      new ClamdScanner('127.0.0.1', silent.port, 300).scan(Buffer.from('x')),
    ).rejects.toThrow(/timed out/);
  });

  it('is configured by DEN_CLAMAV_URL', () => {
    expect(ClamdScanner.fromEnv({})).toBeUndefined();
    expect(ClamdScanner.fromEnv({ DEN_CLAMAV_URL: 'tcp://clamav:3310' })).toBeInstanceOf(
      ClamdScanner,
    );
    expect(() => ClamdScanner.fromEnv({ DEN_CLAMAV_URL: 'http://clamav:3310' })).toThrow(
      /tcp:\/\//,
    );
  });
});
