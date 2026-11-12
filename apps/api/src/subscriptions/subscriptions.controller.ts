import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  type ApproveSubscriptionInput,
  approveSubscriptionSchema,
  type CreateSubscriptionInput,
  createSubscriptionSchema,
  entityIdParamsSchema,
  type RejectSubscriptionInput,
  rejectSubscriptionSchema,
  type RevokeSubscriptionInput,
  revokeSubscriptionSchema,
  subscriptionDetailSchema,
  type SubscriptionListQuery,
  subscriptionListQuerySchema,
  subscriptionPageSchema,
  subscriptionParamsSchema,
} from '@rid/contracts';
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
import { SubscriptionsService } from './subscriptions.service.js';

const subscriptionId = () => new ZodValidationPipe(z.uuid());
const listQuery = () => new ZodValidationPipe(subscriptionListQuerySchema);

/** Consumer side: access requests made by the entity's applications (SPEC.md §4.4). */
@Controller('entities/:entityId/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @EntityAccess('subscription.read')
  @ApiOperation({
    operationId: 'listSubscriptions',
    summary: 'Access requests and subscriptions of the entity as a consumer',
    tags: ['subscriptions'],
    params: entityIdParamsSchema,
    query: subscriptionListQuerySchema,
    responses: { 200: { description: 'A page of subscriptions', schema: subscriptionPageSchema } },
    errors: [400, 401, 403, 404],
  })
  list(@CurrentEntity() entity: EntityContext, @Query(listQuery()) query: SubscriptionListQuery) {
    return this.subscriptions.listForConsumer(entity.entityId, query);
  }

  @Post()
  @EntityAccess('subscription.write')
  @ApiOperation({
    operationId: 'requestAccess',
    summary: 'Ask for access to a published API version for one of the entity’s applications',
    description:
      'Declares the purpose, legal basis, operations and validity. The request waits for the ' +
      'data steward of the provider entity (status pending_provider).',
    tags: ['subscriptions'],
    params: entityIdParamsSchema,
    body: createSubscriptionSchema,
    responses: { 201: { description: 'The access request', schema: subscriptionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  request(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createSubscriptionSchema)) body: CreateSubscriptionInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.subscriptions.request(entity.entityId, principal, body, request.id);
  }

  @Get(':subscriptionId')
  @EntityAccess('subscription.read')
  @ApiOperation({
    operationId: 'getSubscription',
    summary: 'An access request of the entity with its decisions',
    tags: ['subscriptions'],
    params: subscriptionParamsSchema,
    responses: { 200: { description: 'The subscription', schema: subscriptionDetailSchema } },
    errors: [401, 403, 404],
  })
  get(
    @CurrentEntity() entity: EntityContext,
    @Param('subscriptionId', subscriptionId()) id: string,
  ) {
    return this.subscriptions.getForConsumer(entity.entityId, id);
  }
}

/** Provider side: requests other entities made to this entity's APIs (data steward inbox). */
@Controller('entities/:entityId/access-requests')
export class AccessRequestsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @EntityAccess('access_request.read')
  @ApiOperation({
    operationId: 'listAccessRequests',
    summary: 'Access requests to the entity’s APIs',
    tags: ['access-requests'],
    params: entityIdParamsSchema,
    query: subscriptionListQuerySchema,
    responses: { 200: { description: 'A page of requests', schema: subscriptionPageSchema } },
    errors: [400, 401, 403, 404],
  })
  list(@CurrentEntity() entity: EntityContext, @Query(listQuery()) query: SubscriptionListQuery) {
    return this.subscriptions.listForProvider(entity.entityId, query);
  }

  @Get(':subscriptionId')
  @EntityAccess('access_request.read')
  @ApiOperation({
    operationId: 'getAccessRequest',
    summary: 'An access request to one of the entity’s APIs',
    tags: ['access-requests'],
    params: subscriptionParamsSchema,
    responses: { 200: { description: 'The request', schema: subscriptionDetailSchema } },
    errors: [401, 403, 404],
  })
  get(
    @CurrentEntity() entity: EntityContext,
    @Param('subscriptionId', subscriptionId()) id: string,
  ) {
    return this.subscriptions.getForProvider(entity.entityId, id);
  }

  @Post(':subscriptionId/approve')
  @HttpCode(200)
  @EntityAccess('access_request.decide')
  @ApiOperation({
    operationId: 'approveAccessRequest',
    summary: 'Approve an access request, optionally narrowing operations, validity or rate limit',
    description:
      'Moves the request to approved (or to pending_regulator for sensitive data when the ' +
      'country requires it). The requester cannot approve their own request.',
    tags: ['access-requests'],
    params: subscriptionParamsSchema,
    body: approveSubscriptionSchema,
    responses: { 200: { description: 'The decided request', schema: subscriptionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  approve(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('subscriptionId', subscriptionId()) id: string,
    @Body(new ZodValidationPipe(approveSubscriptionSchema)) body: ApproveSubscriptionInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.subscriptions.approve(entity.entityId, id, principal, body, request.id);
  }

  @Post(':subscriptionId/reject')
  @HttpCode(200)
  @EntityAccess('access_request.decide')
  @ApiOperation({
    operationId: 'rejectAccessRequest',
    summary: 'Reject an access request with a reason',
    tags: ['access-requests'],
    params: subscriptionParamsSchema,
    body: rejectSubscriptionSchema,
    responses: { 200: { description: 'The decided request', schema: subscriptionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  reject(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('subscriptionId', subscriptionId()) id: string,
    @Body(new ZodValidationPipe(rejectSubscriptionSchema)) body: RejectSubscriptionInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.subscriptions.reject(entity.entityId, id, principal, body, request.id);
  }

  @Post(':subscriptionId/revoke')
  @HttpCode(200)
  @EntityAccess('access_request.decide')
  @ApiOperation({
    operationId: 'revokeSubscription',
    summary: 'Revoke a subscription to one of the entity’s APIs, with a reason',
    description:
      'Final. The gateway starts denying calls (403 no_subscription) as soon as OPA downloads ' +
      'the next bundle, within 60 seconds.',
    tags: ['access-requests'],
    params: subscriptionParamsSchema,
    body: revokeSubscriptionSchema,
    responses: {
      200: { description: 'The revoked subscription', schema: subscriptionDetailSchema },
    },
    errors: [400, 401, 403, 404, 409],
  })
  revoke(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('subscriptionId', subscriptionId()) id: string,
    @Body(new ZodValidationPipe(revokeSubscriptionSchema)) body: RevokeSubscriptionInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.subscriptions.revoke(entity.entityId, id, principal, body, request.id);
  }
}
