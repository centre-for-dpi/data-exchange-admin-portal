import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import {
  bootcampChecklistSchema,
  bootcampItemParamsSchema,
  entityIdParamsSchema,
  networkBootcampSchema,
  updateBootcampItemSchema,
} from '@rid/contracts';
import {
  type AuthenticatedRequest,
  CurrentEntity,
  CurrentPrincipal,
  EntityAccess,
  type EntityContext,
  PlatformAccess,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { BootcampService } from './bootcamp.service.js';

/** Bootcamp readiness of an entity (M4-07). */
@Controller('entities/:entityId/bootcamp')
export class BootcampController {
  constructor(private readonly bootcamp: BootcampService) {}

  @Get()
  @EntityAccess('bootcamp.read')
  @ApiOperation({
    operationId: 'getBootcampChecklist',
    summary: 'Prerequisites of the bootcamp and their state',
    tags: ['bootcamp'],
    params: entityIdParamsSchema,
    responses: { 200: { description: 'The checklist', schema: bootcampChecklistSchema } },
    errors: [401, 403, 404],
  })
  get(@CurrentEntity() entity: EntityContext) {
    return this.bootcamp.get(entity.entityId);
  }

  @Put(':item')
  @EntityAccess('bootcamp.write')
  @ApiOperation({
    operationId: 'updateBootcampItem',
    summary: 'Confirm (or reopen) a prerequisite of the bootcamp',
    description: 'The designees item is derived from the members and cannot be set.',
    tags: ['bootcamp'],
    params: bootcampItemParamsSchema,
    body: updateBootcampItemSchema,
    responses: { 200: { description: 'The checklist', schema: bootcampChecklistSchema } },
    errors: [400, 401, 403, 404],
  })
  update(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('item') item: string,
    @Body(new ZodValidationPipe(updateBootcampItemSchema)) body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bootcamp.update(
      entity.entityId,
      BootcampService.parseItem(item),
      principal,
      body,
      request.id,
    );
  }
}

/** Readiness of every entity, for the operator who runs the bootcamp (M4-07). */
@Controller('admin/bootcamp')
export class AdminBootcampController {
  constructor(private readonly bootcamp: BootcampService) {}

  @Get()
  @PlatformAccess('bootcamp.list')
  @ApiOperation({
    operationId: 'listNetworkBootcamp',
    summary: 'Bootcamp readiness of every active entity',
    tags: ['bootcamp'],
    responses: { 200: { description: 'The entities', schema: networkBootcampSchema } },
    errors: [401, 403],
  })
  list() {
    return this.bootcamp.network();
  }
}
