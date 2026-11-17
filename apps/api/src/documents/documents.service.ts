import { FieldErrorKey } from '@rid/contracts';
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import {
  ConflictError,
  GoneError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../common/errors.js';
import type { DocumentKind } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AntivirusUnavailableError, ClamdScanner } from './antivirus.js';
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
  private readonly logger = new Logger('Documents');
  /** ClamAV, when RID_CLAMAV_URL is set (M6-08): every document is scanned before it is stored. */
  private readonly antivirus = ClamdScanner.fromEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
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
      throw new ValidationError([
        { path: 'body', message: 'The document is empty', key: FieldErrorKey.EmptyDocument },
      ]);
    }
    if (bytes.length > documentMaxBytes()) {
      throw new PayloadTooLargeError(`The document exceeds ${documentMaxBytes()} bytes`);
    }
    if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new UnsupportedMediaTypeError('Only PDF documents are accepted');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.scan(bytes, sha256, input.kind);
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

  /**
   * The antivirus check, before anything is stored (ASVS 5.4.3). An infected document is refused
   * as a field error; an unreachable antivirus fails the upload (fail closed).
   */
  private async scan(bytes: Buffer, sha256: string, kind: DocumentKind): Promise<void> {
    if (!this.antivirus) return;
    let result;
    try {
      result = await this.antivirus.scan(bytes);
    } catch (error) {
      if (!(error instanceof AntivirusUnavailableError)) throw error;
      this.logger.error(`Antivirus unavailable, upload refused: ${error.message}`);
      throw new ServiceUnavailableError('The antivirus did not answer: try again in a moment');
    }
    if (!result.clean) {
      // The hash identifies the file for the incident; the name or the bytes never reach a log.
      this.logger.warn(
        `Document refused by the antivirus: ${result.signature ?? 'unknown'} (${kind}, sha256 ${sha256})`,
      );
      throw new ValidationError([
        {
          path: 'body',
          message: 'The antivirus found malicious content in the document',
          key: FieldErrorKey.DocumentInfected,
        },
      ]);
    }
  }

  /** Reads a document's bytes; fails if they no longer match the stored hash. */
  async read(documentId: string): Promise<{ document: StoredDocument; bytes: Buffer }> {
    const document = await this.prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    if (document.purgedAt) throw new GoneError('The document was deleted by legal order');
    const bytes = await this.storage.get(document.storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
      throw new Error(`Document ${documentId} does not match its stored hash`);
    }
    return { document, bytes };
  }

  /** The operator's register of documents, newest first; metadata only (M2-07). */
  async list(query: {
    ownerEntityId?: string;
    kind?: DocumentKind;
    purged?: 'true' | 'false';
    cursor?: string;
    limit: number;
  }) {
    const rows = await this.prisma.document.findMany({
      where: {
        ...(query.ownerEntityId ? { ownerEntityId: query.ownerEntityId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.purged ? { purgedAt: query.purged === 'true' ? { not: null } : null } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { ownerEntity: { select: { id: true, shortName: true, slug: true } } },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((d) => ({
        id: d.id,
        kind: d.kind,
        fileName: d.fileName,
        mimeType: d.mimeType,
        size: d.size,
        sha256: d.sha256,
        uploadedAt: d.createdAt.toISOString(),
        owner: d.ownerEntity,
        purgedAt: d.purgedAt?.toISOString() ?? null,
        purgeOrder: d.purgeOrder,
      })),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Deletion by legal order, the only physical deletion in the domain (SPEC.md §5). The bytes
   * go; the row, its SHA-256 and the order stay, and the event is audited. Downloads answer 410.
   */
  async purge(documentId: string, principal: Principal, order: string, requestId?: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundError('Document');
    if (document.purgedAt) throw new ConflictError('The document was already deleted');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.document.updateMany({
        where: { id: documentId, purgedAt: null },
        data: { purgedAt: now, purgedBy: principal.userId, purgeOrder: order },
      });
      if (changed.count === 0) throw new ConflictError('The document changed meanwhile');
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub },
        action: 'document.purged',
        target: { type: 'document', id: documentId },
        before: { sha256: document.sha256, size: document.size, kind: document.kind },
        after: { purgedAt: now.toISOString(), order },
        requestId,
      });
    });
    // After the commit: if this fails the row already says purged and nothing serves the bytes;
    // the deletion can be retried by an operator from the audit trail.
    await this.storage.delete(document.storageKey);
    return { id: documentId, purgedAt: now.toISOString() };
  }
}
