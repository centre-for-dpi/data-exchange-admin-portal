import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { FieldErrorKey } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { ServiceUnavailableError, ValidationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { DocumentsService } from './documents.service.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
// A PDF carrying the EICAR test string: the stand-in below reports it. (A real clamd flags EICAR
// only at the start of a file, which the PDF check refuses before any scan.)
const EICAR = Buffer.from(
  '%PDF-1.7\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF\n',
);

/**
 * Uploads through the antivirus (M6-08): with DEN_CLAMAV_URL set, nothing is stored until clamd
 * says it is clean. A clamd stand-in answers by the content (EICAR found, the rest clean), and can
 * be stopped to see the upload fail closed.
 */
describe('documents through the antivirus (M6-08)', () => {
  const prisma = new PrismaService();
  const documentsDir = mkdtempSync(join(tmpdir(), 'den-documents-'));
  const sockets: Socket[] = [];
  let clamd: Server;
  let app: NestFastifyApplication;
  let owner = '';

  beforeAll(async () => {
    clamd = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.push(socket);
      const chunks: Buffer[] = [];
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        const received = Buffer.concat(chunks);
        socket.end(
          received.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
            ? 'stream: Eicar-Test-Signature FOUND\0'
            : 'stream: OK\0',
        );
      });
    });
    await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', resolve));
    const address = clamd.address();
    process.env.DEN_CLAMAV_URL = `tcp://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    process.env.DEN_DOCUMENTS_DIR = documentsDir;
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers: readRealmUsers(),
    });
    owner = (await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } })).id;
    app = await createTestApp(await createTestIssuer());
  });
  afterAll(async () => {
    delete process.env.DEN_CLAMAV_URL;
    await app.close();
    await prisma.$disconnect();
    for (const s of sockets) s.destroy();
    await new Promise((r) => clamd.close(r));
    rmSync(documentsDir, { recursive: true, force: true });
  });

  const store = (bytes: Buffer, fileName: string) =>
    prisma.$transaction((tx) =>
      app.get(DocumentsService).storePdf(tx, {
        ownerEntityId: owner,
        kind: 'designation',
        fileName,
        bytes,
        createdBy: 'test:antivirus',
      }),
    );

  it('stores a clean document', async () => {
    const stored = await store(PDF, `limpio-${Date.now()}.pdf`);
    expect(stored.size).toBe(PDF.length);
  });

  it('refuses an infected one: no row, no file', async () => {
    const files = readdirSync(documentsDir, { recursive: true }).length;
    const fileName = `infectado-${Date.now()}.pdf`;
    const error = await store(EICAR, fileName).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual([
      expect.objectContaining({ path: 'body', key: FieldErrorKey.DocumentInfected }),
    ]);
    expect(await prisma.document.count({ where: { fileName } })).toBe(0);
    expect(readdirSync(documentsDir, { recursive: true })).toHaveLength(files);
  });

  it('fails closed when the antivirus does not answer', async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => clamd.close(r));
    const fileName = `sin-antivirus-${Date.now()}.pdf`;
    await expect(store(PDF, fileName)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(await prisma.document.count({ where: { fileName } })).toBe(0);
    clamd.listen(0, '127.0.0.1');
  });
});
