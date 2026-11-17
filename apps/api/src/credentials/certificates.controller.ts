import { Body, Controller, Get, Header, Param, Post, Req, Res } from '@nestjs/common';
import {
  applicationParamsSchema,
  credentialParamsSchema,
  type IssueCertificateInput,
  issueCertificateSchema,
  issuedCertificateSchema,
  PEM_CHAIN_MEDIA_TYPE,
} from '@den/contracts';
import type { FastifyReply } from 'fastify';
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
import { CertificatesService } from './certificates.service.js';

const idPipe = () => new ZodValidationPipe(z.uuid());

/** Client certificates of consumer applications (SPEC.md §4.3, M3-01). */
@Controller('entities/:entityId/applications/:applicationId')
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Post('certificates')
  @EntityAccess('application.write')
  @Header('cache-control', 'no-store')
  @ApiOperation({
    operationId: 'issueApplicationCertificate',
    summary: 'Have the network CA sign a client certificate for the application',
    description:
      'Takes a PKCS#10 CSR (PEM) whose subject is CN=<clientId>, with an ECDSA P-256/P-384 or ' +
      'RSA 2048-4096 key. The portal signs it through step-ca for ' +
      'lifecycle.certificateValidityDays and returns the certificate and its chain. One active ' +
      'certificate per application. 503 when the CA is not available.',
    tags: ['applications'],
    params: applicationParamsSchema,
    body: issueCertificateSchema,
    responses: {
      201: { description: 'The certificate', schema: issuedCertificateSchema },
    },
    errors: [400, 401, 403, 404, 409, 503],
  })
  issue(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('applicationId', idPipe()) applicationId: string,
    @Body(new ZodValidationPipe(issueCertificateSchema)) body: IssueCertificateInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.certificates.issue(entity.entityId, principal, applicationId, body, request.id);
  }

  @Get('credentials/:credentialId/certificate')
  @EntityAccess('application.read')
  @ApiOperation({
    operationId: 'downloadApplicationCertificate',
    summary: 'Download a client certificate with its issuing chain (PEM)',
    tags: ['applications'],
    params: credentialParamsSchema,
    responses: { 200: { description: 'The certificate chain', binary: PEM_CHAIN_MEDIA_TYPE } },
    errors: [401, 403, 404],
  })
  async download(
    @CurrentEntity() entity: EntityContext,
    @Param('applicationId', idPipe()) applicationId: string,
    @Param('credentialId', idPipe()) credentialId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.certificates.download(entity.entityId, applicationId, credentialId);
    await reply
      .status(200)
      .header('content-type', PEM_CHAIN_MEDIA_TYPE)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(file.pem);
  }
}
