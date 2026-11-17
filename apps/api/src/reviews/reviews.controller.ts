import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  approveVersionSchema,
  type ApiVersionStatus,
  requestChangesSchema,
  reviewDetailSchema,
  reviewQueueQuerySchema,
  reviewQueueSchema,
  versionIdParamsSchema,
} from '@den/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { ReviewsService } from './reviews.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/** Operator console: review of API versions from every entity (SPEC.md §4.2, §6). */
@Controller('review/api-versions')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @PlatformAccess('review.read')
  @ApiOperation({
    operationId: 'listReviewQueue',
    summary: 'Versions waiting for (or past) operator review',
    tags: ['review'],
    query: reviewQueueQuerySchema,
    responses: { 200: { description: 'The queue', schema: reviewQueueSchema } },
    errors: [400, 401, 403],
  })
  queue(
    @Query(new ZodValidationPipe(reviewQueueQuerySchema))
    query: {
      status: ApiVersionStatus;
      limit: number;
      cursor?: string;
    },
  ) {
    return this.reviews.queue(query.status, query.limit, query.cursor);
  }

  @Get(':versionId')
  @PlatformAccess('review.read')
  @ApiOperation({
    operationId: 'getReview',
    summary: 'Service sheet of a version for review',
    tags: ['review'],
    params: versionIdParamsSchema,
    responses: { 200: { description: 'The version and its API', schema: reviewDetailSchema } },
    errors: [401, 403, 404],
  })
  detail(@Param('versionId', uuid) versionId: string) {
    return this.reviews.detail(versionId);
  }

  @Post(':versionId/approve')
  @HttpCode(200)
  @PlatformAccess('review.decide')
  @ApiOperation({
    operationId: 'approveApiVersion',
    summary: 'Approve a version (publishes it unless the regulator must approve too)',
    description:
      'Publishing creates the gateway route through the reconciler (outbox gateway.sync). The user ' +
      'who submitted the version cannot approve it (separation of duties).',
    tags: ['review'],
    params: versionIdParamsSchema,
    body: approveVersionSchema,
    responses: {
      200: { description: 'The version after the decision', schema: reviewDetailSchema },
    },
    errors: [400, 401, 403, 404, 409],
  })
  approve(
    @Param('versionId', uuid) versionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(approveVersionSchema)) body: { comment?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reviews.approve(versionId, principal, body.comment, request.id);
  }

  @Post(':versionId/request-changes')
  @HttpCode(200)
  @PlatformAccess('review.decide')
  @ApiOperation({
    operationId: 'requestApiVersionChanges',
    summary: 'Send a version back to the provider with a comment',
    tags: ['review'],
    params: versionIdParamsSchema,
    body: requestChangesSchema,
    responses: {
      200: { description: 'The version after the decision', schema: reviewDetailSchema },
    },
    errors: [400, 401, 403, 404, 409],
  })
  requestChanges(
    @Param('versionId', uuid) versionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(requestChangesSchema)) body: { comment: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reviews.requestChanges(versionId, principal, body.comment, request.id);
  }
}
