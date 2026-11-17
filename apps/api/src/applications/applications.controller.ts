import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import {
  applicationDetailSchema,
  applicationPageSchema,
  applicationParamsSchema,
  type CreateApplicationInput,
  createApplicationSchema,
  createdApplicationSchema,
  entityIdParamsSchema,
  type PaginationQuery,
  paginationQuerySchema,
} from '@den/contracts';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  CurrentEntity,
  CurrentPrincipal,
  EntityAccess,
  type EntityContext,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { ApplicationsService } from './applications.service.js';

@Controller('entities/:entityId/applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Get()
  @EntityAccess('application.read')
  @ApiOperation({
    operationId: 'listApplications',
    summary: 'Consumer applications of the entity',
    tags: ['applications'],
    params: entityIdParamsSchema,
    query: paginationQuerySchema,
    responses: { 200: { description: 'A page of applications', schema: applicationPageSchema } },
    errors: [400, 401, 403, 404],
  })
  list(
    @CurrentEntity() entity: EntityContext,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.applications.list(entity.entityId, query);
  }

  @Post()
  @EntityAccess('application.write')
  // The response carries a secret: it must never be cached anywhere.
  @Header('cache-control', 'no-store')
  @ApiOperation({
    operationId: 'createApplication',
    summary: 'Create an application and its OAuth2 client credentials',
    description:
      'Returns the client secret once; it cannot be retrieved again. The Keycloak client is ' +
      'created asynchronously by the reconciler (provisioning: pending -> ready).',
    tags: ['applications'],
    params: entityIdParamsSchema,
    body: createApplicationSchema,
    responses: {
      201: { description: 'The application and its secret', schema: createdApplicationSchema },
    },
    errors: [400, 401, 403, 404],
  })
  create(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createApplicationSchema)) body: CreateApplicationInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.applications.create(entity.entityId, principal, body, request.id);
  }

  @Get(':applicationId')
  @EntityAccess('application.read')
  @ApiOperation({
    operationId: 'getApplication',
    summary: 'Application with its credentials (metadata only) and provisioning state',
    tags: ['applications'],
    params: applicationParamsSchema,
    responses: { 200: { description: 'The application', schema: applicationDetailSchema } },
    errors: [401, 403, 404],
  })
  get(
    @CurrentEntity() entity: EntityContext,
    @Param('applicationId', new ZodValidationPipe(z.uuid())) applicationId: string,
  ) {
    return this.applications.get(entity.entityId, applicationId);
  }
}
