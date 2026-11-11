import { Controller, Get, Query } from '@nestjs/common';
import {
  type EntitySummary,
  entityIdParamsSchema,
  entityMembersPageSchema,
  entitySummarySchema,
  type PaginationQuery,
  paginationQuerySchema,
} from '@rid/contracts';
import type { z } from 'zod';
import { CurrentEntity, EntityAccess, type EntityContext } from '../auth/decorators.js';
import { NotFoundError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';

@Controller('entities/:entityId')
export class EntitiesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @EntityAccess('entity.read')
  @ApiOperation({
    operationId: 'getEntity',
    summary: 'Entity details',
    tags: ['entities'],
    params: entityIdParamsSchema,
    responses: { 200: { description: 'The entity', schema: entitySummarySchema } },
    errors: [401, 403, 404],
  })
  async get(@CurrentEntity() entity: EntityContext): Promise<EntitySummary> {
    const row = await this.prisma.entity.findUnique({ where: { id: entity.entityId } });
    if (!row) throw new NotFoundError('Entity');
    return {
      id: row.id,
      slug: row.slug,
      legalName: row.legalName,
      shortName: row.shortName,
      kind: row.kind,
      sector: row.sector,
      status: row.status,
      contactEmail: row.contactEmail,
      website: row.website,
    };
  }

  @Get('members')
  @EntityAccess('entity.members.read')
  @ApiOperation({
    operationId: 'listEntityMembers',
    summary: 'Members of the entity and their roles',
    tags: ['entities'],
    params: entityIdParamsSchema,
    query: paginationQuerySchema,
    responses: { 200: { description: 'A page of members', schema: entityMembersPageSchema } },
    errors: [400, 401, 403, 404],
  })
  async members(
    @CurrentEntity() entity: EntityContext,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<z.infer<typeof entityMembersPageSchema>> {
    const rows = await scopedRepo(this.prisma.membership, entity.entityId).findMany({
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    // Users are looked up only for memberships already scoped to this entity.
    const users = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: page.map((m) => m.userId) } },
          select: { id: true, fullName: true, email: true },
        })
      ).map((u) => [u.id, u]),
    );
    return {
      items: page.flatMap((m) => {
        const user = users.get(m.userId);
        return user ? [{ membershipId: m.id, user, roles: m.roles, status: m.status }] : [];
      }),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
