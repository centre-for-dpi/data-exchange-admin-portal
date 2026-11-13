import { Injectable } from '@nestjs/common';
import type {
  SubjectAccessesQuery,
  SubjectAccessItem,
  SubjectAccessPage,
  TransparencyReceipt,
} from '@rid/contracts';
import { NotFoundError } from '../../common/errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TransparencyEvidenceService } from '../evidence/transparency-evidence.service.js';

type Localized = string | Record<string, string>;

const isLocalized = (value: unknown): value is Localized =>
  typeof value === 'string' ||
  (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string'));

/** The summary of an operation in a stored OpenAPI document, if it has one. */
function operationSummary(spec: unknown, operationId: string): string | null {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> } | null)?.paths ?? {};
  for (const item of Object.values(paths)) {
    for (const operation of Object.values(item ?? {})) {
      const op = operation as { operationId?: unknown; summary?: unknown } | null;
      if (op?.operationId === operationId)
        return typeof op.summary === 'string' ? op.summary : null;
    }
  }
  return null;
}

const exposedData = (value: unknown): SubjectAccessItem['data'] =>
  Array.isArray(value)
    ? value
        .filter(
          (f): f is { name: string; personal?: unknown; sensitive?: unknown } =>
            typeof (f as { name?: unknown } | null)?.name === 'string',
        )
        .map((f) => ({
          name: f.name,
          personal: f.personal === true,
          sensitive: f.sensitive === true,
        }))
    : [];

const encodeCursor = (at: Date, id: string) => `${at.getTime()}_${id}`;
const decodeCursor = (cursor: string) => {
  const [ms, id] = cursor.split('_');
  return { at: new Date(Number(ms)), id: id ?? '' };
};

/**
 * The citizen's view of the transparency register (ADR-0015, MT-05): the calls about them, found
 * only by the pseudonym derived from their own token. Names come from the current catalogue; the
 * record itself keeps the identifiers, so a renamed entity shows its current name.
 */
@Injectable()
export class DataSubjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: TransparencyEvidenceService,
  ) {}

  async accesses(ref: string, query: SubjectAccessesQuery): Promise<SubjectAccessPage> {
    const where: Prisma.SubjectAccessRecordWhereInput = { subjectRef: ref };
    if (query.cursor) {
      const { at, id } = decodeCursor(query.cursor);
      where.OR = [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: id } }];
    }
    const rows = await this.prisma.subjectAccessRecord.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const unique = <T>(values: T[]) => [...new Set(values)];

    const [entities, applications, versions, purposes, leaves] = await Promise.all([
      this.prisma.entity.findMany({
        where: {
          id: { in: unique(page.flatMap((r) => [r.consumerEntityId, r.providerEntityId])) },
        },
        select: { id: true, legalName: true, shortName: true },
      }),
      this.prisma.application.findMany({
        where: { id: { in: unique(page.map((r) => r.applicationId)) } },
        select: { id: true, name: true },
      }),
      this.prisma.apiVersion.findMany({
        where: { id: { in: unique(page.map((r) => r.apiVersionId)) } },
        select: { id: true, version: true, openapiSpec: true, api: { select: { name: true } } },
      }),
      this.prisma.purpose.findMany({
        where: { code: { in: unique(page.map((r) => r.purposeCode)) } },
        select: { code: true, name: true },
      }),
      this.prisma.transparencyLeaf.findMany({
        where: { recordId: { in: page.map((r) => r.id) } },
        select: { recordId: true },
      }),
    ]);
    const entity = new Map(entities.map((e) => [e.id, e]));
    const application = new Map(applications.map((a) => [a.id, a.name]));
    const version = new Map(versions.map((v) => [v.id, v]));
    const purpose = new Map(purposes.map((p) => [p.code, p.name]));
    const sealed = new Set(leaves.map((l) => l.recordId));
    const entityView = (id: string) => {
      const e = entity.get(id);
      return e ? { name: e.legalName, shortName: e.shortName } : null;
    };

    const items = page.map((r): SubjectAccessItem => {
      const v = version.get(r.apiVersionId);
      const purposeName = purpose.get(r.purposeCode);
      return {
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        consumer: {
          entity: entityView(r.consumerEntityId),
          application: application.get(r.applicationId) ?? null,
        },
        provider: entityView(r.providerEntityId),
        api: v ? { name: v.api.name, version: v.version } : null,
        operation: {
          id: r.operationId,
          summary: v ? operationSummary(v.openapiSpec, r.operationId) : null,
        },
        purpose: { code: r.purposeCode, name: isLocalized(purposeName) ? purposeName : null },
        data: exposedData(r.exposedFields),
        officialRef: r.endUserHash,
        status: r.status,
        sealed: sealed.has(r.id),
      };
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }

  /** Receipt of one of the citizen's own consultations; anyone else's is not found. */
  async receipt(ref: string, id: string): Promise<TransparencyReceipt> {
    const own = await this.prisma.subjectAccessRecord.findFirst({
      where: { id, subjectRef: ref },
      select: { id: true },
    });
    if (!own) throw new NotFoundError('Consultation');
    return this.evidence.receipt(id);
  }
}
