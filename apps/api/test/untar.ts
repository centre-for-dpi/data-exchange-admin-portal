import { gunzipSync } from 'node:zlib';
import { expect } from 'vitest';

/** Reads back the entries of a tar archive (name -> content). */
export function untar(archive: Buffer): Map<string, string> {
  const tar = gunzipSync(archive);
  const entries = new Map<string, string>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, ''), 8);
    // The checksum covers the header with the checksum field read as spaces.
    const stored = parseInt(header.subarray(148, 156).toString('ascii'), 8);
    let sum = 0;
    header.forEach((byte, i) => (sum += i >= 148 && i < 156 ? 32 : byte));
    expect(sum).toBe(stored);
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
