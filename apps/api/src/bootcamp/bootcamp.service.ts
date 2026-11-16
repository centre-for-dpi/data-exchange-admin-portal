import { Injectable } from '@nestjs/common';
import {
  BOOTCAMP_ITEMS,
  type BootcampChecklist,
  type BootcampItem,
  manualBootcampItemSchema,
  updateBootcampItemSchema,
} from '@rid/contracts';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { NotFoundError, ValidationError } from '../common/errors.js';
import type { BootcampChecklistItem } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';

/** Roles that must have an active member for the `designees` item (SPEC.md §2.2). */
const DESIGNEE_ROLES = ['api_publisher', 'data_steward'] as const;

type ManualItem = z.infer<typeof manualBootcampItemSchema>;

function checklist(stored: BootcampChecklistItem[], designees: boolean): BootcampChecklist {
  const items = BOOTCAMP_ITEMS.map((item: BootcampItem) => {
    if (item === 'designees') {
      return {
        item,
        status: designees ? ('done' as const) : ('pending' as const),
        automatic: true,
        note: null,
        manualStepsAvoided: null,
        updatedAt: null,
      };
    }
    const row = stored.find((r) => r.item === item);
    return {
      item,
      status: row?.status ?? ('pending' as const),
      automatic: false,
      note: row?.note ?? null,
      manualStepsAvoided: row?.manualStepsAvoided ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
  return { items, ready: items.every((i) => i.status === 'done') };
}

/**
 * Bootcamp readiness of an entity (M4-07): the prerequisites to install its node (a server, a
 * read-only database user, outbound HTTPS on 443, the people designated, a use case). The
 * designees item comes from the members; the others are confirmed by the entity's admin or the
 * operator, audited. The operator sees every entity's state.
 */
@Injectable()
export class BootcampService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async designees(entityIds: string[]): Promise<Set<string>> {
    const rows = await this.prisma.membership.findMany({
      where: { entityId: { in: entityIds }, status: 'active' },
      select: { entityId: true, roles: true },
    });
    return new Set(
      entityIds.filter((id) =>
        DESIGNEE_ROLES.every((role) =>
          rows.some((m) => m.entityId === id && m.roles.includes(role)),
        ),
      ),
    );
  }

  async get(entityId: string): Promise<BootcampChecklist> {
    const stored = await scopedRepo(this.prisma.bootcampChecklistItem, entityId).findMany({});
    return checklist(stored, (await this.designees([entityId])).has(entityId));
  }

  async update(
    entityId: string,
    item: ManualItem,
    principal: Principal,
    input: unknown,
    requestId?: string,
  ): Promise<BootcampChecklist> {
    const data = updateBootcampItemSchema.parse(input);
    if (data.manualStepsAvoided != null && item !== 'use_case') {
      throw new ValidationError([
        { path: 'manualStepsAvoided', message: 'Only the use case counts manual steps' },
      ]);
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.bootcampChecklistItem.findUnique({
        where: { entityId_item: { entityId, item } },
      });
      const after = await tx.bootcampChecklistItem.upsert({
        where: { entityId_item: { entityId, item } },
        create: {
          entityId,
          item,
          status: data.status,
          note: data.note ?? null,
          manualStepsAvoided: data.manualStepsAvoided ?? null,
          updatedBy: principal.userId,
        },
        update: {
          status: data.status,
          ...(data.note !== undefined ? { note: data.note || null } : {}),
          ...(data.manualStepsAvoided !== undefined
            ? { manualStepsAvoided: data.manualStepsAvoided }
            : {}),
          updatedBy: principal.userId,
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: principal.keycloakSub, entityId },
        action: 'bootcamp.item_updated',
        target: { type: 'entity', id: entityId },
        before: before
          ? {
              item,
              status: before.status,
              note: before.note,
              manualStepsAvoided: before.manualStepsAvoided,
            }
          : { item },
        after: {
          item,
          status: after.status,
          note: after.note,
          manualStepsAvoided: after.manualStepsAvoided,
        },
        requestId,
      });
    });
    return this.get(entityId);
  }

  /** Every active entity and its readiness, the ready ones last. */
  async network() {
    const entities = await this.prisma.entity.findMany({
      where: { status: 'active' },
      select: { id: true, slug: true, shortName: true },
      orderBy: { shortName: 'asc' },
      take: 1_000,
    });
    const ids = entities.map((e) => e.id);
    const [stored, designees] = await Promise.all([
      this.prisma.bootcampChecklistItem.findMany({ where: { entityId: { in: ids } } }),
      this.designees(ids),
    ]);
    const items = entities.map((entity) => {
      const list = checklist(
        stored.filter((s) => s.entityId === entity.id),
        designees.has(entity.id),
      );
      return {
        entity,
        checklist: list,
        done: list.items.filter((i) => i.status === 'done').length,
        total: list.items.length,
      };
    });
    items.sort((a, b) => a.done - b.done || a.entity.shortName.localeCompare(b.entity.shortName));
    return { items };
  }

  /** 404 for an item outside the checklist, as for any unknown resource. */
  static parseItem(value: string): ManualItem {
    const parsed = manualBootcampItemSchema.safeParse(value);
    if (!parsed.success) throw new NotFoundError('Checklist item');
    return parsed.data;
  }
}
