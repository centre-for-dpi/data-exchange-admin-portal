import { FieldErrorKey } from '@den/contracts';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuditExportQuery } from '@den/contracts';
import { CompactSign } from 'jose';
import type { Principal } from '../auth/principal.service.js';
import { ValidationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TransparencySigningKey } from '../transparency/evidence/signing-key.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditService } from './audit.service.js';

/** Events in one export; a larger trail is exported by date ranges. */
export const EXPORT_MAX_EVENTS = 50_000;
const COLUMNS = [
  'seq',
  'occurredAt',
  'actorType',
  'actorId',
  'actorEntityId',
  'action',
  'targetType',
  'targetId',
  'requestId',
  'prevHash',
  'hash',
  'before',
  'after',
] as const;

/** CSV cell: quoted, and never read as a spreadsheet formula (= + - @ at the start). */
function cell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? value.toString()
          : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export interface AuditExport {
  body: Buffer;
  contentType: string;
  fileName: string;
  sha256: string;
  /** Compact JWS (EdDSA, operator key of /transparency/jwks) over the export manifest. */
  signature: string | null;
  count: number;
}

/**
 * Signed export of the audit trail (SPEC.md §6, M2-09). The file carries every field of each
 * event, the hashes included, so anyone can recompute the chain. Its SHA-256 is signed in a
 * manifest {sha256, format, count, filters, exportedAt, firstSeq, lastSeq} with the operator's
 * key, verifiable with the public JWKS. Each export is itself audited (`audit.exported`).
 */
@Injectable()
export class AuditExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly key: TransparencySigningKey,
  ) {}

  async export(
    query: AuditExportQuery,
    principal: Principal,
    requestId?: string,
  ): Promise<AuditExport> {
    const { format, ...filters } = query;
    const where = AuditQueryService.where(filters);
    const count = await this.prisma.auditEvent.count({ where });
    if (count > EXPORT_MAX_EVENTS) {
      throw new ValidationError([
        {
          path: 'from',
          message: `${count} events match; narrow the filters to at most ${EXPORT_MAX_EVENTS}`,
          key: FieldErrorKey.ExportTooLarge,
          params: { count, max: EXPORT_MAX_EVENTS },
        },
      ]);
    }
    const rows = await this.prisma.auditEvent.findMany({ where, orderBy: { seq: 'asc' } });
    const records = rows.map((r) => ({
      seq: r.seq.toString(),
      occurredAt: r.occurredAt.toISOString(),
      actorType: r.actorType,
      actorId: r.actorId,
      actorEntityId: r.actorEntityId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      requestId: r.requestId,
      prevHash: r.prevHash,
      hash: r.hash,
      before: r.before,
      after: r.after,
    }));
    const body =
      format === 'json'
        ? Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8')
        : Buffer.from(
            [
              COLUMNS.join(','),
              ...records.map((r) => COLUMNS.map((c) => cell(r[c])).join(',')),
            ].join('\r\n') + '\r\n',
            'utf8',
          );
    const sha256 = createHash('sha256').update(body).digest('hex');
    const exportedAt = new Date().toISOString();
    const manifest = {
      sha256,
      format,
      count: records.length,
      filters,
      exportedAt,
      firstSeq: records[0]?.seq ?? null,
      lastSeq: records.at(-1)?.seq ?? null,
    };
    const signature = this.key.configured()
      ? await new CompactSign(new TextEncoder().encode(JSON.stringify(manifest)))
          .setProtectedHeader({ alg: 'EdDSA', kid: this.key.kid(), typ: 'den-audit-export+jws' })
          .sign(await this.key.signingKey())
      : null;
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub },
        action: 'audit.exported',
        target: { type: 'audit_export', id: sha256 },
        after: { format, count: records.length, filters, sha256 },
        requestId,
      }),
    );
    return {
      body,
      contentType: format === 'json' ? 'application/json' : 'text/csv; charset=utf-8',
      fileName: `audit-${exportedAt.slice(0, 10)}.${format}`,
      sha256,
      signature,
      count: records.length,
    };
  }
}
