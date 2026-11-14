import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../common/errors.js';
import type { DocumentKind } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { StorageService } from './storage.service.js';

export const PDF_MIME = 'application/pdf';
const PDF_MAGIC = Buffer.from('%PDF-');

/** Largest document accepted (RID_DOCUMENT_MAX_BYTES, default 10 MiB). */
export const documentMaxBytes = (): number => {
  const value = Number(process.env.RID_DOCUMENT_MAX_BYTES ?? 10 * 1024 * 1024);
  return Number.isInteger(value) && value > 0 ? value : 10 * 1024 * 1024;
};

export interface StoredDocument {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: Date;
}

/**
 * Attached documents (SPEC.md §3: only PDF in the MVP). The row keeps the SHA-256; the bytes go
 * to StorageService. Every download is checked against the stored hash.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Checks and stores a PDF, then creates its row inside `tx`. The bytes are written first: if
   * the transaction rolls back, an unreferenced file stays behind (harmless, never served).
   */
  async storePdf(
    tx: Tx,
    input: {
      ownerEntityId: string;
      kind: DocumentKind;
      fileName: string;
      bytes: Buffer;
      createdBy: string;
    },
  ): Promise<StoredDocument> {
    const { bytes } = input;
    if (bytes.length === 0) {
      throw new ValidationError([{ path: 'body', message: 'The document is empty' }]);
    }
    if (bytes.length > documentMaxBytes()) {
      throw new PayloadTooLargeError(`The document exceeds ${documentMaxBytes()} bytes`);
    }
    if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new UnsupportedMediaTypeError('Only PDF documents are accepted');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storageKey = await this.storage.put(bytes);
    return tx.document.create({
      data: {
        ownerEntityId: input.ownerEntityId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: PDF_MIME,
        size: bytes.length,
        sha256,
        storageKey,
        createdBy: input.createdBy,
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        size: true,
        sha256: true,
        createdAt: true,
      },
    });
  }

  /** Reads a document's bytes; fails if they no longer match the stored hash. */
  async read(documentId: string): Promise<{ document: StoredDocument; bytes: Buffer }> {
    const document = await this.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const bytes = await this.storage.get(document.storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
      throw new Error(`Document ${documentId} does not match its stored hash`);
    }
    return { document, bytes };
  }
}
