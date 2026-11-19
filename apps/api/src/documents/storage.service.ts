import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Where document bytes live (ARCHITECTURE.md §12): a local volume, DEN_DOCUMENTS_DIR. Keys are
 * random UUIDs chosen here, never names from the uploader, so a key cannot point outside the
 * directory. An S3-compatible adapter (SeaweedFS, Garage) can replace this behind the same
 * interface. Files are written to a temporary name and renamed, so a reader never sees half a file.
 */
@Injectable()
export class StorageService {
  readonly dir = resolve(process.env.DEN_DOCUMENTS_DIR ?? 'data/documents');

  async put(bytes: Buffer): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    const temporary = join(this.dir, `.${key}.part`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, this.path(key));
    return key;
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  /** The bytes as a stream, for large files (the kit's mirrored bundle, P-03), and their size. */
  async open(key: string): Promise<{ size: number; stream: ReadStream }> {
    const path = this.path(key);
    const { size } = await stat(path);
    return { size, stream: createReadStream(path) };
  }

  /** Deletes the bytes for good (legal order); a missing file is not an error. */
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('Invalid storage key');
    return join(this.dir, key);
  }
}
