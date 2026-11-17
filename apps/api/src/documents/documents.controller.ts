import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  documentIdParamsSchema,
  documentListQuerySchema,
  documentPageSchema,
  purgeDocumentSchema,
  purgedDocumentSchema,
} from '@den/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { DocumentsService } from './documents.service.js';

/** Operator actions on attached documents (SPEC.md §5, M2-07). */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @PlatformAccess('document.list')
  @ApiOperation({
    operationId: 'listDocuments',
    summary: 'Register of attached documents',
    description:
      'Metadata only (name, kind, size, SHA-256, owner, deletion): the operator finds here the ' +
      'document a legal order names. The bytes are never listed.',
    tags: ['documents'],
    query: documentListQuerySchema,
    responses: { 200: { description: 'A page of documents', schema: documentPageSchema } },
    errors: [400, 401, 403],
  })
  list(
    @Query(new ZodValidationPipe(documentListQuerySchema))
    query: z.infer<typeof documentListQuerySchema>,
  ) {
    return this.documents.list(query);
  }

  @Post(':documentId/purge')
  @HttpCode(200)
  @PlatformAccess('document.purge')
  @ApiOperation({
    operationId: 'purgeDocument',
    summary: 'Delete a document’s bytes by legal order',
    description:
      'The only physical deletion in the domain. The record, its SHA-256 and the order stay and ' +
      'the deletion is audited; downloads answer 410 from then on.',
    tags: ['documents'],
    params: documentIdParamsSchema,
    body: purgeDocumentSchema,
    responses: { 200: { description: 'The deletion', schema: purgedDocumentSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  purge(
    @Param('documentId', new ZodValidationPipe(z.uuid())) documentId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(purgeDocumentSchema)) body: { order: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.documents.purge(documentId, principal, body.order, request.id);
  }
}
