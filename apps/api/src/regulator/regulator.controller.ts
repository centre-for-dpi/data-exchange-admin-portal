import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  regulatorDecisionSchema,
  regulatorQueueSchema,
  regulatorReasonSchema,
  reviewDetailSchema,
  subscriptionDetailSchema,
  subscriptionIdParamsSchema,
  versionIdParamsSchema,
} from '@den/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { RegulatorService } from './regulator.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/** The regulator's approvals (SPEC.md §2.1, §6; M2-04). */
@Controller('regulator')
export class RegulatorController {
  constructor(private readonly regulator: RegulatorService) {}

  @Get('approvals')
  @PlatformAccess('regulator.read')
  @ApiOperation({
    operationId: 'listRegulatorApprovals',
    summary: 'Sensitive publications and access requests waiting for the regulator',
    tags: ['regulator'],
    responses: { 200: { description: 'The inbox', schema: regulatorQueueSchema } },
    errors: [401, 403],
  })
  queue() {
    return this.regulator.queue();
  }

  @Post('api-versions/:versionId/approve')
  @HttpCode(200)
  @PlatformAccess('regulator.decide')
  @ApiOperation({
    operationId: 'regulatorApproveApiVersion',
    summary: 'Approve a sensitive version: it is published',
    description:
      'Only for versions the operator already approved that need the regulator ' +
      '(features.approval.regulatorForSensitive). Publishing enqueues the gateway sync.',
    tags: ['regulator'],
    params: versionIdParamsSchema,
    body: regulatorDecisionSchema,
    responses: { 200: { description: 'The version', schema: reviewDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  approveVersion(
    @Param('versionId', uuid) versionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(regulatorDecisionSchema)) body: { comment?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.regulator.approveVersion(versionId, principal, body.comment, request.id);
  }

  @Post('api-versions/:versionId/request-changes')
  @HttpCode(200)
  @PlatformAccess('regulator.decide')
  @ApiOperation({
    operationId: 'regulatorReturnApiVersion',
    summary: 'Send a sensitive version back to the provider with a reason',
    tags: ['regulator'],
    params: versionIdParamsSchema,
    body: regulatorReasonSchema,
    responses: { 200: { description: 'The version', schema: reviewDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  returnVersion(
    @Param('versionId', uuid) versionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(regulatorReasonSchema)) body: { comment: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.regulator.returnVersion(versionId, principal, body.comment, request.id);
  }

  @Post('subscriptions/:subscriptionId/approve')
  @HttpCode(200)
  @PlatformAccess('regulator.decide')
  @ApiOperation({
    operationId: 'regulatorApproveSubscription',
    summary: 'Approve an access request to sensitive data',
    description:
      'Only for requests the data steward already approved (pending_regulator). The validity the ' +
      'steward granted counts from this decision. Enqueues the policy sync.',
    tags: ['regulator'],
    params: subscriptionIdParamsSchema,
    body: regulatorDecisionSchema,
    responses: { 200: { description: 'The request', schema: subscriptionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  approveSubscription(
    @Param('subscriptionId', uuid) subscriptionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(regulatorDecisionSchema)) body: { comment?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.regulator.approveSubscription(subscriptionId, principal, body.comment, request.id);
  }

  @Post('subscriptions/:subscriptionId/reject')
  @HttpCode(200)
  @PlatformAccess('regulator.decide')
  @ApiOperation({
    operationId: 'regulatorRejectSubscription',
    summary: 'Reject an access request to sensitive data, with a reason',
    tags: ['regulator'],
    params: subscriptionIdParamsSchema,
    body: regulatorReasonSchema,
    responses: { 200: { description: 'The request', schema: subscriptionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  rejectSubscription(
    @Param('subscriptionId', uuid) subscriptionId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(regulatorReasonSchema)) body: { comment: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.regulator.rejectSubscription(subscriptionId, principal, body.comment, request.id);
  }
}
