import { Injectable } from '@nestjs/common';
import type { PurposeAdmin } from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LIVE_STATUSES } from '../domain/subscription/state-machine.js';

interface PurposeInput {
  name: { es: string; en: string };
  description: { es: string; en: string };
  legalReference?: string;
}

/**
 * Purpose catalogue administration (SPEC.md §3, M2-10). Purposes from the country config are
 * edited there (the seed keeps them in sync) but the operator can deactivate them; purposes the
 * operator adds are fully editable here. Nothing is deleted: a deactivated purpose cannot be
 * chosen for new versions or requests, and the subscriptions that already use it keep it.
 */
@Injectable()
export class PurposesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private actor(principal: Principal) {
    return { type: 'user' as const, id: principal.keycloakSub };
  }

  async list(): Promise<{ items: PurposeAdmin[] }> {
    const rows = await this.prisma.purpose.findMany({
      orderBy: { code: 'asc' },
      include: {
        _count: {
          select: {
            apiVersions: { where: { apiVersion: { status: { not: 'retired' } } } },
            subscriptions: { where: { status: { in: [...LIVE_STATUSES] } } },
          },
        },
      },
    });
    return {
      items: rows.map((p) => ({
        code: p.code,
        name: p.name as PurposeAdmin['name'],
        description: p.description as PurposeAdmin['description'],
        legalReference: p.legalReference,
        source: p.source,
        active: p.active,
        usage: { versions: p._count.apiVersions, subscriptions: p._count.subscriptions },
      })),
    };
  }

  private async find(code: string) {
    const purpose = await this.prisma.purpose.findUnique({ where: { code } });
    if (!purpose) throw new NotFoundError('Purpose');
    return purpose;
  }

  async create(principal: Principal, input: PurposeInput & { code: string }, requestId?: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.purpose.create({
          data: {
            code: input.code,
            name: input.name,
            description: input.description,
            legalReference: input.legalReference ?? null,
            source: 'operator',
            createdBy: principal.userId,
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'purpose.created',
          target: { type: 'purpose', id: created.code },
          after: created,
          requestId,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`The catalogue already has a purpose "${input.code}"`);
      }
      throw error;
    }
    return this.list();
  }

  async update(principal: Principal, code: string, input: PurposeInput, requestId?: string) {
    const before = await this.find(code);
    if (before.source === 'config') {
      throw new ConflictError('This purpose comes from the country configuration; edit it there');
    }
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.purpose.update({
        where: { code },
        data: {
          name: input.name,
          description: input.description,
          legalReference: input.legalReference ?? null,
        },
      });
      await this.audit.record(tx, {
        actor: this.actor(principal),
        action: 'purpose.updated',
        target: { type: 'purpose', id: code },
        before,
        after,
        requestId,
      });
    });
    return this.list();
  }

  async setActive(principal: Principal, code: string, active: boolean, requestId?: string) {
    const before = await this.find(code);
    if (before.active === active) {
      throw new ConflictError(`The purpose is already ${active ? 'active' : 'inactive'}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.purpose.update({ where: { code }, data: { active } });
      await this.audit.record(tx, {
        actor: this.actor(principal),
        action: active ? 'purpose.activated' : 'purpose.deactivated',
        target: { type: 'purpose', id: code },
        before: { active: before.active },
        after: { active },
        requestId,
      });
    });
    return this.list();
  }
}
