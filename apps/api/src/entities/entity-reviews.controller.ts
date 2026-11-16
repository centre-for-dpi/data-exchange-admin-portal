import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  approveEntitySchema,
  entityDecisionWithReasonSchema,
  entityRequestIdParamsSchema,
  entityRequestListSchema,
  entityRequestSchema,
  type EntityReviewQueueQuery,
  entityReviewQueueQuerySchema,
} from '@rid/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { EntityRequestsService } from './entity-requests.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/** Operator console: onboarding requests from every applicant (SPEC.md §4.1, §6). */
@Controller('review/entities')
export class EntityReviewsController {
  constructor(private readonly requests: EntityRequestsService) {}

  @Get()
  @PlatformAccess('entity_review.read')
  @ApiOperation({
    operationId: 'listEntityReviewQueue',
    summary: 'Onboarding requests in one status (default: under review)',
    tags: ['review'],
    query: entityReviewQueueQuerySchema,
    responses: { 200: { description: 'The queue', schema: entityRequestListSchema } },
    errors: [400, 401, 403],
  })
  queue(@Query(new ZodValidationPipe(entityReviewQueueQuerySchema)) query: EntityReviewQueueQuery) {
    return this.requests.queue(query.status, query.limit, query.cursor);
  }

  @Post(':requestId/approve')
  @HttpCode(200)
  @PlatformAccess('entity_review.decide')
  @ApiOperation({
    operationId: 'approveEntityRequest',
    summary: 'Approve the entity',
    description:
      'The entity becomes `active`, the applicant becomes entity_admin and each designee gets an ' +
      'invitation by e-mail. Nobody decides on a request they filed or that designates them.',
    tags: ['review'],
    params: entityRequestIdParamsSchema,
    body: approveEntitySchema,
    responses: { 200: { description: 'The request', schema: entityRequestSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  approve(
    @Param('requestId', uuid) requestId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(approveEntitySchema)) body: { comment?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.requests.approve(requestId, principal, body.comment, request.id);
  }

  @Post(':requestId/request-changes')
  @HttpCode(200)
  @PlatformAccess('entity_review.decide')
  @ApiOperation({
    operationId: 'requestEntityChanges',
    summary: 'Send the request back to the applicant with a comment',
    tags: ['review'],
    params: entityRequestIdParamsSchema,
    body: entityDecisionWithReasonSchema,
    responses: { 200: { description: 'The request', schema: entityRequestSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  requestChanges(
    @Param('requestId', uuid) requestId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(entityDecisionWithReasonSchema)) body: { comment: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.requests.requestChanges(requestId, principal, body.comment, request.id);
  }

  @Post(':requestId/reject')
  @HttpCode(200)
  @PlatformAccess('entity_review.decide')
  @ApiOperation({
    operationId: 'rejectEntityRequest',
    summary: 'Reject the request (final)',
    description: 'A rejected request frees its identifier and tax id for a new request.',
    tags: ['review'],
    params: entityRequestIdParamsSchema,
    body: entityDecisionWithReasonSchema,
    responses: { 200: { description: 'The request', schema: entityRequestSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  reject(
    @Param('requestId', uuid) requestId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(entityDecisionWithReasonSchema)) body: { comment: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.requests.reject(requestId, principal, body.comment, request.id);
  }
}
