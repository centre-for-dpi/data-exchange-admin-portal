import { Injectable } from '@nestjs/common';
import type {
  AuditEventsQuery,
  AuditFilters,
  AuditItem,
  ChainCheckResult,
  Timeline,
  TimelineKind,
} from '@den/contracts';
import { NotFoundError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TsaClient } from '../transparency/evidence/tsa.client.js';
import { verifyTimestampToken } from '@den/transparency-verifier';
import { getCountryConfig } from '@den/config';
import { localDay, nextDay } from '../common/local-day.js';
import { ANCHOR_STAMP_SKEW_MS } from './audit-anchor.service.js';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly tsa: TsaClient,
  ) {}

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
    const chain = verifier.check();
    const anchors = await this.verifyAnchors();
    return {
      ...chain,
      // Anchors whose time-stamp could not be checked (no TSA roots) do not make the check valid.
      valid:
        chain.valid &&
        anchors.problems.length === 0 &&
        (anchors.checked === 0 || anchors.timestampsChecked),
      anchors,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Each daily anchor (M2-09) must still find its event with the same hash: an anchor without
   * its event means the chain lost its tail (or more) after the anchor was taken.
   */
  private async verifyAnchors(): Promise<ChainCheckResult['anchors']> {
    const anchors = await this.prisma.auditAnchor.findMany({
      orderBy: { day: 'asc' },
      select: { day: true, lastSeq: true, lastHash: true, tsaToken: true, tsaGenTime: true },
    });
    const roots = await (anchors.length > 0 ? this.tsa.certificates() : Promise.resolve([])).catch(
      () => null,
    );
    const events = new Map(
      (
        await this.prisma.auditEvent.findMany({
          where: { seq: { in: anchors.map((a) => a.lastSeq) } },
          select: { seq: true, hash: true },
        })
      ).map((e) => [e.seq, e.hash]),
    );
    const problems: ChainCheckResult['anchors']['problems'] = [];
    const now = Date.now();
    // Tomorrow's date is tolerated: the daily anchoring is exercised with a clock a day or two
    // ahead (the integration suite does), and the days of a country's time zone and the
    // database's differ at the edges. What stops anchoring for good is a day well ahead.
    const tomorrow = nextDay(localDay(new Date(now), getCountryConfig().country.timezone));
    for (const anchor of anchors) {
      const hash = events.get(anchor.lastSeq);
      if (hash === undefined) problems.push({ day: anchor.day, reason: 'event_missing' });
      else if (hash !== anchor.lastHash)
        problems.push({ day: anchor.day, reason: 'hash_mismatch' });
      // An anchor dated beyond tomorrow, or stamped in the future, would stop the anchoring (a day
      // is never anchored before the one of the latest anchor) and cannot be an honest stamp.
      if (anchor.day > tomorrow || anchor.tsaGenTime.getTime() > now + ANCHOR_STAMP_SKEW_MS) {
        problems.push({ day: anchor.day, reason: 'future_dated' });
      }
      if (roots && roots.length > 0 && !(await this.stampHolds(anchor, roots))) {
        problems.push({ day: anchor.day, reason: 'timestamp_invalid' });
      }
    }
    return {
      checked: anchors.length,
      lastDay: anchors.at(-1)?.day ?? null,
      timestampsChecked: roots !== null,
      problems,
    };
  }

  /**
   * The stored RFC 3161 token is a valid stamp, by a trusted TSA, over the anchor's hash, and says
   * the time that was stored with it (B-02).
   */
  private async stampHolds(
    anchor: { lastHash: string; tsaToken: Uint8Array; tsaGenTime: Date },
    roots: string[],
  ): Promise<boolean> {
    try {
      const stamp = await verifyTimestampToken(
        new Uint8Array(anchor.tsaToken),
        new TextEncoder().encode(anchor.lastHash),
        roots,
      );
      return stamp.genTime.getTime() === anchor.tsaGenTime.getTime();
    } catch {
      return false;
    }
  }

  /** The WHERE of the network trail for a set of filters (list and export). */
  static where(filters: AuditFilters): Prisma.AuditEventWhereInput {
    const action = filters.action;
    return {
      ...(action
        ? action.includes('.')
          ? { action }
          : { action: { startsWith: `${action}.` } }
        : {}),
      ...(filters.targetType ? { targetType: filters.targetType } : {}),
      ...(filters.targetId ? { targetId: filters.targetId } : {}),
      ...(filters.entityId ? { actorEntityId: filters.entityId } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.from || filters.to
        ? {
            occurredAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    };
  }

  /** Newest first, across the network (platform view). */
  async recent(query: AuditEventsQuery) {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        ...AuditQueryService.where(query),
        ...(query.cursor ? { seq: { lt: BigInt(query.cursor) } } : {}),
      },
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
