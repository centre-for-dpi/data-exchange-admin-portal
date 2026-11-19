import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  FieldErrorKey,
  kitBundleFileName,
  type CurrentKitRelease,
  type KitRelease,
  type KitReleaseList,
  type PublicKitRelease,
} from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../common/errors.js';
import { StorageService } from '../documents/storage.service.js';
import type { KitRelease as KitReleaseRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Largest bundle the mirror accepts (DEN_KIT_BUNDLE_MAX_BYTES, default 128 MiB). */
export const kitBundleMaxBytes = (): number => {
  const value = Number(process.env.DEN_KIT_BUNDLE_MAX_BYTES ?? 128 * 1024 * 1024);
  return Number.isInteger(value) && value > 0 ? value : 128 * 1024 * 1024;
};

export interface KitReleaseInput {
  url: string;
  sizeBytes: number;
  sha256: string;
  signatureUrl?: string;
  allowedSigners?: string;
}

/** What the audit trail keeps of a release: everything but the storage key. */
const audited = (row: KitReleaseRow) => ({
  version: row.version,
  url: row.url,
  fileName: row.fileName,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  signatureUrl: row.signatureUrl,
  allowedSigners: row.allowedSigners,
  mirrored: row.mirrorStorageKey !== null,
});

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * The releases of the node kit the operator offers (P-03). The kit is another product
 * (ADR-0011): the portal keeps which version is current, its link, size and SHA-256 and, once
 * releases are signed, the signature's link and the operator's allowed_signers. Optionally it
 * mirrors the bundle, for entities whose servers reach the portal but not GitHub: the bytes are
 * accepted only if they are the declared ones, and never change afterwards, so the mirror's
 * versioned path can be cached for good. Nothing here is secret: the enrollment token is.
 */
@Injectable()
export class KitReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private actor(principal: Principal) {
    return { type: 'user' as const, id: principal.keycloakSub };
  }

  private toPublic(row: KitReleaseRow): PublicKitRelease {
    return {
      version: row.version,
      url: row.url,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      signatureUrl: row.signatureUrl,
      allowedSigners: row.allowedSigners,
      mirrored: row.mirrorStorageKey !== null,
      madeCurrentAt: iso(row.madeCurrentAt),
    };
  }

  private currentRow() {
    return this.prisma.kitRelease.findFirst({
      where: { madeCurrentAt: { not: null } },
      orderBy: { madeCurrentAt: 'desc' },
    });
  }

  /** The version offered now (public): the one the operator made current last. */
  async current(): Promise<CurrentKitRelease> {
    const row = await this.currentRow();
    return { release: row ? this.toPublic(row) : null };
  }

  /** Every release, newest first, for the operator console. */
  async list(): Promise<KitReleaseList> {
    const [rows, current] = await Promise.all([
      this.prisma.kitRelease.findMany({ orderBy: { createdAt: 'desc' } }),
      this.currentRow(),
    ]);
    return {
      items: rows.map((row): KitRelease => ({
        ...this.toPublic(row),
        current: row.id === current?.id,
        mirroredAt: iso(row.mirroredAt),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Registers a release, or corrects one, and makes it the current version. Each change is
   * audited in the same transaction: created or updated (before and after), and made current
   * when it was not. A mirrored release keeps its size and checksum: its path never serves other
   * bytes.
   */
  async set(
    principal: Principal,
    version: string,
    input: KitReleaseInput,
    requestId?: string,
  ): Promise<KitReleaseList> {
    const fileName = kitBundleFileName(input.url);
    if (!fileName) throw new Error('The link was validated to end in a bundle file name');
    const data = {
      url: input.url,
      fileName,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      signatureUrl: input.signatureUrl ?? null,
      allowedSigners: input.allowedSigners ?? null,
    };
    const actor = this.actor(principal);
    await this.prisma.$transaction(async (tx) => {
      // One writer at a time: which release is current is decided in commit order.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('den_kit_release'))`;
      const before = await tx.kitRelease.findUnique({ where: { version } });
      const current = await tx.kitRelease.findFirst({
        where: { madeCurrentAt: { not: null } },
        orderBy: { madeCurrentAt: 'desc' },
        select: { id: true },
      });
      let row: KitReleaseRow;
      if (!before) {
        row = await tx.kitRelease.create({
          data: { version, ...data, createdBy: principal.userId },
        });
        await this.audit.record(tx, {
          actor,
          action: 'kit_release.created',
          target: { type: 'kit_release', id: row.id },
          after: audited(row),
          requestId,
        });
      } else {
        const changed = (Object.keys(data) as Array<keyof typeof data>).some(
          (key) => before[key] !== data[key],
        );
        row = before;
        if (changed) {
          if (
            before.mirrorStorageKey &&
            (before.sha256 !== data.sha256 ||
              before.sizeBytes !== data.sizeBytes ||
              before.fileName !== data.fileName)
          ) {
            throw new ConflictError(
              `Version ${version} is mirrored: its file, size and checksum cannot change`,
              { key: FieldErrorKey.KitBundleMirrored },
            );
          }
          row = await tx.kitRelease.update({ where: { id: before.id }, data });
          await this.audit.record(tx, {
            actor,
            action: 'kit_release.updated',
            target: { type: 'kit_release', id: row.id },
            before: audited(before),
            after: audited(row),
            requestId,
          });
        }
      }
      if (current?.id !== row.id) {
        row = await tx.kitRelease.update({
          where: { id: row.id },
          data: { madeCurrentAt: new Date() },
        });
        await this.audit.record(tx, {
          actor,
          action: 'kit_release.made_current',
          target: { type: 'kit_release', id: row.id },
          before: { currentReleaseId: current?.id ?? null },
          after: { currentReleaseId: row.id, version: row.version },
          requestId,
        });
      }
    });
    return this.list();
  }

  /**
   * Mirrors a release's bundle: accepted only when its size and SHA-256 are the declared ones.
   * The bytes are stored first, as documents are; a failed transaction leaves an unreferenced
   * file, never served.
   */
  async mirror(
    principal: Principal,
    version: string,
    bytes: Buffer,
    requestId?: string,
  ): Promise<KitReleaseList> {
    if (bytes.length > kitBundleMaxBytes()) {
      throw new PayloadTooLargeError(`The bundle exceeds ${kitBundleMaxBytes()} bytes`);
    }
    const release = await this.prisma.kitRelease.findUnique({ where: { version } });
    if (!release) throw new NotFoundError('Kit release');
    if (release.mirrorStorageKey) {
      throw new ConflictError(`The bundle of version ${version} is already mirrored`, {
        key: FieldErrorKey.KitBundleMirrored,
      });
    }
    if (bytes.length !== release.sizeBytes) {
      throw new ValidationError([
        {
          path: 'body',
          message: `The bundle has ${bytes.length} bytes; the release says ${release.sizeBytes}`,
          key: FieldErrorKey.KitBundleSizeMismatch,
        },
      ]);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== release.sha256) {
      throw new ValidationError([
        {
          path: 'body',
          message: 'The SHA-256 of the bundle is not the one of the release',
          key: FieldErrorKey.KitBundleChecksumMismatch,
        },
      ]);
    }
    const key = await this.storage.put(bytes);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.kitRelease.updateMany({
        where: { id: release.id, mirrorStorageKey: null },
        data: { mirrorStorageKey: key, mirroredAt: new Date() },
      });
      // Someone else mirrored it meanwhile: theirs stands, this copy is never referenced.
      if (updated.count === 0) {
        throw new ConflictError(`The bundle of version ${version} is already mirrored`, {
          key: FieldErrorKey.KitBundleMirrored,
        });
      }
      await this.audit.record(tx, {
        actor: this.actor(principal),
        action: 'kit_release.mirrored',
        target: { type: 'kit_release', id: release.id },
        after: { version, fileName: release.fileName, sizeBytes: bytes.length, sha256 },
        requestId,
      });
    });
    return this.list();
  }

  /**
   * A mirrored file of a release (public): the bundle, or `<fileName>.sha256` in the format
   * `sha256sum -c` reads. Any mirrored version, not only the current one.
   */
  async mirroredFile(version: string, file: string) {
    const release = await this.prisma.kitRelease.findUnique({ where: { version } });
    if (!release?.mirrorStorageKey) throw new NotFoundError('Kit bundle');
    if (file === release.fileName) {
      const { size, stream } = await this.storage.open(release.mirrorStorageKey);
      return { kind: 'bundle' as const, fileName: release.fileName, size, stream };
    }
    if (file === `${release.fileName}.sha256`) {
      return {
        kind: 'checksum' as const,
        fileName: file,
        text: `${release.sha256}  ${release.fileName}\n`,
      };
    }
    throw new NotFoundError('Kit bundle');
  }
}
