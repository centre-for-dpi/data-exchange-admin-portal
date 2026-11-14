import type { FastifyReply } from 'fastify';
import { PDF_MIME, type StoredDocument } from './documents.service.js';

/**
 * Sends a stored PDF as a download: never rendered inline, never sniffed, no scripts, no cache,
 * with its SHA-256 as Digest so the receiver can check it.
 */
export async function sendPdf(
  reply: FastifyReply,
  document: StoredDocument,
  bytes: Buffer,
): Promise<void> {
  await reply
    .status(200)
    .header('content-type', PDF_MIME)
    .header(
      'content-disposition',
      `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
    )
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'no-store')
    .header('digest', `sha-256=${Buffer.from(document.sha256, 'hex').toString('base64')}`)
    .send(bytes);
}

/** Published paths (under the API prefix) that receive a PDF body (bigger body limit). */
export const PDF_UPLOAD_PATHS = [
  'entity-requests/:requestId/designation-document',
  'entities/:entityId/subscriptions/:subscriptionId/agreement',
] as const;
