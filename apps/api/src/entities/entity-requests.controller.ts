import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  documentFileNameQuerySchema,
  entityRequestIdParamsSchema,
  entityRequestInputSchema,
  entityRequestListSchema,
  entityRequestSchema,
} from '@rid/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, SignedIn } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { UnsupportedMediaTypeError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PDF_MIME } from '../documents/documents.service.js';
import { sendPdf } from '../documents/pdf-reply.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { EntityRequestsService } from './entity-requests.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/**
 * Onboarding requests, from the applicant's side (SPEC.md §4.1). Any signed-in user may file one
 * (ADR-0018); only its applicant and the operator can see it, everyone else gets 404.
 */
@SignedIn()
@Controller('entity-requests')
export class EntityRequestsController {
  constructor(private readonly requests: EntityRequestsService) {}

  @Post()
  @ApiOperation({
    operationId: 'createEntityRequest',
    summary: 'Ask for an entity to join the network',
    description:
      'Creates the request in `requested`. The applicant then attaches the designation document ' +
      'and submits it. Each person can have a few open requests at a time.',
    tags: ['entity-requests'],
    body: entityRequestInputSchema,
    responses: { 201: { description: 'The request', schema: entityRequestSchema } },
    errors: [400, 401, 403, 409],
  })
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(entityRequestInputSchema))
    body: z.output<typeof entityRequestInputSchema>,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.requests.create(body, principal, request.id);
  }

  @Get()
  @ApiOperation({
    operationId: 'listMyEntityRequests',
    summary: 'Onboarding requests the caller filed',
    tags: ['entity-requests'],
    responses: { 200: { description: 'The requests', schema: entityRequestListSchema } },
    errors: [401, 403],
  })
  mine(@CurrentPrincipal() principal: Principal) {
    return this.requests.mine(principal);
  }

  @Get(':requestId')
  @ApiOperation({
    operationId: 'getEntityRequest',
    summary: 'An onboarding request, with the operator’s decisions',
    tags: ['entity-requests'],
    params: entityRequestIdParamsSchema,
    responses: { 200: { description: 'The request', schema: entityRequestSchema } },
    errors: [401, 403, 404],
  })
  get(@Param('requestId', uuid) requestId: string, @CurrentPrincipal() principal: Principal) {
    return this.requests.get(requestId, principal);
  }

  @Put(':requestId')
  @ApiOperation({
    operationId: 'updateEntityRequest',
    summary: 'Change the request while it is with the applicant',
    tags: ['entity-requests'],
    params: entityRequestIdParamsSchema,
    body: entityRequestInputSchema,
    responses: { 200: { description: 'The request', schema: entityRequestSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  update(
    @Param('requestId', uuid) requestId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(entityRequestInputSchema))
    body: z.output<typeof entityRequestInputSchema>,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.requests.update(requestId, body, principal, request.id);
  }

  @Put(':requestId/designation-document')
  @ApiOperation({
    operationId: 'putEntityDesignationDocument',
    summary: 'Attach the designation document (PDF)',
    description:
      'The body is the PDF itself (`Content-Type: application/pdf`), up to RID_DOCUMENT_MAX_BYTES ' +
      '(10 MiB by default). The portal keeps its SHA-256 and checks it on every download. ' +
      'Replaces any previous document.',
    tags: ['entity-requests'],
    params: entityRequestIdParamsSchema,
    query: documentFileNameQuerySchema,
    binaryBody: PDF_MIME,
    responses: { 200: { description: 'The request', schema: entityRequestSchema } },
    errors: [400, 401, 403, 404, 409, 413, 415],
  })
  attach(
    @Param('requestId', uuid) requestId: string,
    @Query(new ZodValidationPipe(documentFileNameQuerySchema)) query: { fileName: string },
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!Buffer.isBuffer(body))
      throw new UnsupportedMediaTypeError('Send the PDF as application/pdf');
    return this.requests.attachDesignation(
      requestId,
      { fileName: query.fileName, bytes: body },
      principal,
      request.id,
    );
  }

  @Get(':requestId/designation-document')
  @ApiOperation({
    operationId: 'getEntityDesignationDocument',
    summary: 'Download the designation document',
    tags: ['entity-requests'],
    params: entityRequestIdParamsSchema,
    responses: { 200: { description: 'The PDF', binary: PDF_MIME } },
    errors: [401, 403, 404],
  })
  async download(
    @Param('requestId', uuid) requestId: string,
    @CurrentPrincipal() principal: Principal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { document, bytes } = await this.requests.designationDocument(requestId, principal);
    await sendPdf(reply, document, bytes);
  }

  @Post(':requestId/submit')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'submitEntityRequest',
    summary: 'Send the request to the operator for review',
    description: 'Requires the designation document. Moves the request to `under_review`.',
    tags: ['entity-requests'],
    params: entityRequestIdParamsSchema,
    responses: { 200: { description: 'The request', schema: entityRequestSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  submit(
    @Param('requestId', uuid) requestId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.requests.submit(requestId, principal, request.id);
  }
}
