import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import {
  type CertificateRevocationFilter,
  certificateRevocationFilterSchema,
  certificateRevocationPreviewSchema,
  certificateRevocationResultSchema,
  type ExecuteCertificateRevocationInput,
  executeCertificateRevocationSchema,
} from '@rid/contracts';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { CertificateRevocationsService } from './certificate-revocations.service.js';

/** Operator console: mass revocation of client certificates in an incident (M6-07). */
@Controller('admin/certificate-revocations')
export class CertificateRevocationsController {
  constructor(private readonly revocations: CertificateRevocationsService) {}

  @Get('preview')
  @PlatformAccess('certificate.mass_revoke')
  @ApiOperation({
    operationId: 'previewCertificateRevocation',
    summary: 'What a mass revocation with these filters would revoke',
    description:
      'Live client certificates (active or rotating) matching every filter, by entity, and the ' +
      'intermediates that issued them. No filter: every certificate of the network.',
    tags: ['applications'],
    query: certificateRevocationFilterSchema,
    responses: { 200: { description: 'The preview', schema: certificateRevocationPreviewSchema } },
    errors: [400, 401, 403],
  })
  preview(
    @Query(new ZodValidationPipe(certificateRevocationFilterSchema))
    query: CertificateRevocationFilter,
  ) {
    return this.revocations.preview(query);
  }

  @Post()
  @PlatformAccess('certificate.mass_revoke')
  @ApiOperation({
    operationId: 'executeCertificateRevocation',
    summary: 'Revoke every live client certificate matching the filters',
    description:
      'Each one stops working with the next OPA bundle (under 60 s) and its application’s ' +
      'developers are told. `expectedCount` is the preview’s count: if the set changed since, ' +
      '409 and nothing is revoked.',
    tags: ['applications'],
    body: executeCertificateRevocationSchema,
    responses: {
      201: { description: 'The revocation', schema: certificateRevocationResultSchema },
    },
    errors: [400, 401, 403, 409],
  })
  execute(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(executeCertificateRevocationSchema))
    body: ExecuteCertificateRevocationInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.revocations.execute(principal, body, request.id);
  }
}
