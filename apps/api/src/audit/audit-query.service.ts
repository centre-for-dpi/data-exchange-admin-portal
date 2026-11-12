import { Injectable } from '@nestjs/common';
import type {
  AuditEventsQuery,
  AuditItem,
  ChainCheckResult,
  Timeline,
  TimelineKind,
} from '@rid/contracts';
import { NotFoundError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChainVerifier } from './chain.js';

type EventRow = Prisma.AuditEventGetPayload<object>;

const VERIFY_BATCH = 1_000;

const text = (value: unknown, key: string): string | null => {
  const field =
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof field === 'string' ? field : null;
};

/**
 * Reading the audit trail (M1-11): verification of the hash chain and timelines per object.
 * Platform roles see the whole network with names; an entity sees the timelines of its own
 * objects, with the names of its own people only (SPEC.md §6: "cada entidad ve lo suyo").
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Walks the whole chain in seq order, in batches. */
  async verify(): Promise<ChainCheckResult> {
    const verifier = new ChainVerifier();
    let after: bigint | undefined;
    for (;;) {
      const batch = await this.prisma.auditEvent.findMany({
        where: after === undefined ? {} : { seq: { gt: after } },
        orderBy: { seq: 'asc' },
        take: VERIFY_BATCH,
      });
      for (const event of batch) verifier.push(event);
      if (batch.length < VERIFY_BATCH || verifier.done) break;
      after = batch.at(-1)?.seq;
    }
    return { ...verifier.check(), checkedAt: new Date().toISOString() };
  }

  /** Newest first, across the network (platform view). */
  async recent(query: AuditEventsQuery) {
    const rows = await this.prisma.auditEvent.findMany({
      where: query.cursor ? { seq: { lt: BigInt(query.cursor) } } : {},
      orderBy: { seq: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: await this.toItems(page, { names: 'all' }),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.seq.toString() ?? null) : null,
    };
  }

  /**
   * Timeline of a subscription or an API (with its versions), oldest first. With `entityId`,
   * the object must belong to that entity (404 otherwise, like any other entity resource).
   */
  async timeline(kind: TimelineKind, id: string, entityId?: string): Promise<Timeline> {
    let targets: Prisma.AuditEventWhereInput[];
    if (kind === 'subscription') {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id },
        select: {
          application: { select: { entityId: true } },
          apiVersion: { select: { api: { select: { entityId: true } } } },
        },
      });
      const owners = [subscription?.application.entityId, subscription?.apiVersion.api.entityId];
      if (!subscription || (entityId && !owners.includes(entityId))) {
        throw new NotFoundError('Subscription');
      }
      targets = [{ targetType: 'subscription', targetId: id }];
    } else {
      const api = await this.prisma.api.findUnique({
        where: { id },
        select: { entityId: true, versions: { select: { id: true } } },
      });
      if (!api || (entityId && api.entityId !== entityId)) throw new NotFoundError('API');
      targets = [
        { targetType: 'api', targetId: id },
        { targetType: 'api_version', targetId: { in: api.versions.map((v) => v.id) } },
      ];
    }
    const rows = await this.prisma.auditEvent.findMany({
      where: { OR: targets },
      orderBy: { seq: 'asc' },
      take: 500,
    });
    return {
      items: await this.toItems(rows, entityId ? { names: 'entity', entityId } : { names: 'all' }),
    };
  }

  private async toItems(
    rows: EventRow[],
    scope: { names: 'all' } | { names: 'entity'; entityId: string },
  ): Promise<AuditItem[]> {
    const subs = [...new Set(rows.filter((r) => r.actorType === 'user').map((r) => r.actorId))];
    const entityIds = [
      ...new Set(rows.map((r) => r.actorEntityId).filter((e): e is string => Boolean(e))),
    ];
    const [users, entities] = await Promise.all([
      this.prisma.user.findMany({
        where: { keycloakSub: { in: subs } },
        select: { keycloakSub: true, fullName: true },
      }),
      this.prisma.entity.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, slug: true, shortName: true },
      }),
    ]);
    const nameBySub = new Map(users.map((u) => [u.keycloakSub, u.fullName]));
    const entityById = new Map(entities.map((e) => [e.id, e]));

    return rows.map((r) => {
      const entity = r.actorEntityId ? entityById.get(r.actorEntityId) : undefined;
      // An entity reads the names of its own people; other actors appear by entity or role.
      const showName =
        r.actorType === 'user' && (scope.names === 'all' || r.actorEntityId === scope.entityId);
      const from = text(r.before, 'status');
      const to = text(r.after, 'status');
      return {
        seq: r.seq.toString(),
        occurredAt: r.occurredAt.toISOString(),
        action: r.action,
        actor: {
          type: r.actorType,
          name: showName ? (nameBySub.get(r.actorId) ?? null) : null,
          entity: entity ? { slug: entity.slug, shortName: entity.shortName } : null,
          system: r.actorType === 'system' ? r.actorId : null,
        },
        target: { type: r.targetType, id: r.targetId },
        status: from || to ? { from, to } : null,
        comment: text(r.after, 'comment'),
        hash: r.hash,
      };
    });
  }
}
