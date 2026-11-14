import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  adminEntityListSchema,
  adminEntityQuerySchema,
  adminEntitySchema,
  createEntitySchema,
  type EntityStatus,
  adminEntityParamsSchema,
  offboardEntitySchema,
  reactivateEntitySchema,
  suspendEntitySchema,
} from '@rid/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { EntityRequestsService } from './entity-requests.service.js';
import { EntityStatusService } from './entity-status.service.js';

/** Operator console: entities of the network, their suspension and offboarding (M2-11). */
@Controller('admin/entities')
export class AdminEntitiesController {
  constructor(
    private readonly entities: EntityStatusService,
    private readonly requests: EntityRequestsService,
  ) {}

  @Post()
  @PlatformAccess('entity_admin.create')
  @ApiOperation({
    operationId: 'createNetworkEntity',
    summary: 'Register an entity directly',
    description:
      'Without an onboarding request: the entity is active at once, its administrator and ' +
      'designees are invited by e-mail, and `basis` (the act or decision) is audited ' +
      '(SPEC.md §4.1 step 1).',
    tags: ['entities'],
    body: createEntitySchema,
    responses: { 201: { description: 'The entity', schema: adminEntitySchema } },
    errors: [400, 401, 403],
  })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createEntitySchema)) body: z.output<typeof createEntitySchema>,
    @Req() request: AuthenticatedRequest,
  ) {
    const id = await this.requests.createDirect(body, principal, request.id);
    return this.entities.one(id);
  }

  @Get()
  @PlatformAccess('entity_admin.read')
  @ApiOperation({
    operationId: 'listNetworkEntities',
    summary: 'Entities of the network with their status and activity',
    tags: ['entities'],
    query: adminEntityQuerySchema,
    responses: { 200: { description: 'The entities', schema: adminEntityListSchema } },
    errors: [400, 401, 403],
  })
  list(@Query(new ZodValidationPipe(adminEntityQuerySchema)) query: { status?: EntityStatus }) {
    return this.entities.list(query.status);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @PlatformAccess('entity_admin.decide')
  @ApiOperation({
    operationId: 'suspendEntity',
    summary: 'Suspend an entity',
    description:
      'Its applications are denied at the gateway and it publishes nothing new; with ' +
      '`alsoAsProvider`, its APIs stop serving other entities too (SPEC.md §4.1 step 4).',
    tags: ['entities'],
    params: adminEntityParamsSchema,
    body: suspendEntitySchema,
    responses: { 200: { description: 'The entities', schema: adminEntityListSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  suspend(
    @Param('id', new ZodValidationPipe(z.uuid())) entityId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(suspendEntitySchema))
    body: { comment: string; alsoAsProvider: boolean },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.entities.suspend(entityId, principal, body, request.id);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @PlatformAccess('entity_admin.decide')
  @ApiOperation({
    operationId: 'reactivateEntity',
    summary: 'Lift an entity’s suspension',
    tags: ['entities'],
    params: adminEntityParamsSchema,
    body: reactivateEntitySchema,
    responses: { 200: { description: 'The entities', schema: adminEntityListSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  reactivate(
    @Param('id', new ZodValidationPipe(z.uuid())) entityId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(reactivateEntitySchema)) body: { comment?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.entities.reactivate(entityId, principal, body.comment, request.id);
  }

  @Post(':id/offboard')
  @HttpCode(200)
  @PlatformAccess('entity_admin.decide')
  @ApiOperation({
    operationId: 'offboardEntity',
    summary: 'Offboard an entity (final)',
    description:
      'Closes its subscriptions as consumer and provider, retires its versions (gateway routes ' +
      'removed) and revokes its memberships and pending invitations.',
    tags: ['entities'],
    params: adminEntityParamsSchema,
    body: offboardEntitySchema,
    responses: { 200: { description: 'The entities', schema: adminEntityListSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  offboard(
    @Param('id', new ZodValidationPipe(z.uuid())) entityId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(offboardEntitySchema)) body: { comment: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.entities.offboard(entityId, principal, body.comment, request.id);
  }
}
