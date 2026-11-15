import { Controller, Get, Inject, Res } from '@nestjs/common';
import { PEM_CHAIN_MEDIA_TYPE } from '@rid/contracts';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { CERTIFICATE_AUTHORITY, type CertificateAuthority } from './step-ca.client.js';

/**
 * The root of the network CA (M3-10). Applications trust the gateway's server certificate with it
 * (curl --cacert), since step-ca issues that certificate too. A root certificate is public.
 */
@Public()
@Controller('pki')
export class NetworkCaController {
  constructor(@Inject(CERTIFICATE_AUTHORITY) private readonly ca: CertificateAuthority) {}

  @Get('ca')
  @ApiOperation({
    operationId: 'downloadNetworkCa',
    summary: 'Root certificate of the network CA (PEM)',
    description:
      'The trust anchor of the gateway certificate and of the client certificates of applications.',
    tags: ['credentials'],
    responses: { 200: { description: 'The root certificate', binary: PEM_CHAIN_MEDIA_TYPE } },
    errors: [503],
  })
  async root(@Res() reply: FastifyReply): Promise<void> {
    const pem = await this.ca.rootCertificate();
    await reply
      .status(200)
      .header('content-type', PEM_CHAIN_MEDIA_TYPE)
      .header('content-disposition', 'attachment; filename="rid-network-ca.pem"')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=3600')
      .send(pem);
  }
}
