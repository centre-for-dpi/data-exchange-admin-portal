import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  auditEventPageSchema,
  type AuditEventsQuery,
  auditEventsQuerySchema,
  chainCheckSchema,
  entityTimelineParamsSchema,
  timelineKindSchema,
  type TimelineKind,
  timelineParamsSchema,
  timelineSchema,
} from '@rid/contracts';
import { z } from 'zod';
import {
  CurrentEntity,
  EntityAccess,
  type EntityContext,
  PlatformAccess,
} from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { AuditQueryService } from './audit-query.service.js';

const kindPipe = () => new ZodValidationPipe(timelineKindSchema);
const idPipe = () => new ZodValidationPipe(z.uuid());

/** Network-wide audit trail for the operator, the regulator and auditors (SPEC.md §6). */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get('verify')
  @PlatformAccess('audit.read')
  @ApiOperation({
    operationId: 'verifyAuditChain',
    summary: 'Verify the integrity of the whole audit hash chain',
    description:
      'Recomputes every hash: a modified, removed or inserted event breaks the chain and the ' +
      'first broken event is reported.',
    tags: ['audit'],
    responses: { 200: { description: 'Verification result', schema: chainCheckSchema } },
    errors: [401, 403],
  })
  verify() {
    return this.audit.verify();
  }

  @Get('events')
  @PlatformAccess('audit.read')
  @ApiOperation({
    operationId: 'listAuditEvents',
    summary: 'Audit events of the network, newest first',
    tags: ['audit'],
    query: auditEventsQuerySchema,
    responses: { 200: { description: 'A page of events', schema: auditEventPageSchema } },
    errors: [400, 401, 403],
  })
  events(@Query(new ZodValidationPipe(auditEventsQuerySchema)) query: AuditEventsQuery) {
    return this.audit.recent(query);
  }

  @Get('timeline/:kind/:id')
  @PlatformAccess('audit.read')
  @ApiOperation({
    operationId: 'getAuditTimeline',
    summary: 'Timeline of a subscription or an API (with its versions)',
    tags: ['audit'],
    params: timelineParamsSchema,
    responses: { 200: { description: 'Events, oldest first', schema: timelineSchema } },
    errors: [400, 401, 403, 404],
  })
  timeline(@Param('kind', kindPipe()) kind: TimelineKind, @Param('id', idPipe()) id: string) {
    return this.audit.timeline(kind, id);
  }
}

/** Timelines of an entity's own objects (SPEC.md §6: each entity sees its own). */
@Controller('entities/:entityId/audit')
export class EntityAuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get('timeline/:kind/:id')
  @EntityAccess('audit.entity.read')
  @ApiOperation({
    operationId: 'getEntityAuditTimeline',
    summary: 'Timeline of one of the entity’s subscriptions or APIs',
    description:
      'Subscriptions are visible to both the consumer and the provider entity. Names are shown ' +
      'only for the entity’s own people.',
    tags: ['audit'],
    params: entityTimelineParamsSchema,
    responses: { 200: { description: 'Events, oldest first', schema: timelineSchema } },
    errors: [400, 401, 403, 404],
  })
  timeline(
    @CurrentEntity() entity: EntityContext,
    @Param('kind', kindPipe()) kind: TimelineKind,
    @Param('id', idPipe()) id: string,
  ) {
    return this.audit.timeline(kind, id, entity.entityId);
  }
}
