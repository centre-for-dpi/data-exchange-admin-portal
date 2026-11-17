import { connect } from 'node:net';

/**
 * Antivirus check of uploaded documents with ClamAV (M6-08, ASVS 5.4.3). clamd runs as its own
 * service (GPL-2.0, never linked: CLAUDE.md rule 1) and the API speaks its INSTREAM protocol over
 * TCP: `zINSTREAM\0`, the bytes in chunks each preceded by its length (4 bytes, big-endian), a
 * zero-length chunk to end, and one reply line: `stream: OK` or `stream: <signature> FOUND`.
 *
 * RID_CLAMAV_URL (tcp://clamav:3310) turns it on. While it is on, a document is stored only after
 * clamd says it is clean: an unreachable or erroring clamd fails the upload (503), never lets the
 * document through.
 */
export interface ScanResult {
  clean: boolean;
  /** The signature clamd found, when it is not clean. */
  signature?: string;
}

export class AntivirusUnavailableError extends Error {}

const CHUNK = 64 * 1024;

export class ClamdScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  /** tcp://host:port, or undefined when the variable is empty. Throws on anything else. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ClamdScanner | undefined {
    const raw = env.RID_CLAMAV_URL?.trim();
    if (!raw) return undefined;
    const url = new URL(raw);
    if (url.protocol !== 'tcp:' || !url.hostname) {
      throw new Error(`RID_CLAMAV_URL must be tcp://host:port, got "${raw}"`);
    }
    return new ClamdScanner(url.hostname, Number(url.port || 3310));
  }

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const replies: Buffer[] = [];
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new AntivirusUnavailableError(`clamd: ${reason}`));
      };
      socket.setTimeout(this.timeoutMs, () => fail('timed out'));
      socket.on('error', (error) => fail(error.message));
      socket.on('data', (data) => replies.push(data));
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
        const found = /^stream: (.+) FOUND$/.exec(reply);
        if (reply === 'stream: OK') resolve({ clean: true });
        else if (found) resolve({ clean: false, signature: found[1] ?? '' });
        else
          reject(new AntivirusUnavailableError(`clamd: unexpected reply "${reply.slice(0, 200)}"`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const chunk = bytes.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}
