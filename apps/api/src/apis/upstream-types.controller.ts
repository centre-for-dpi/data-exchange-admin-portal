import { Controller, Get } from '@nestjs/common';
import { type UpstreamTypes, upstreamTypesSchema } from '@den/contracts';
import { SignedIn } from '../auth/decorators.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { allowedUpstreamTypes } from './upstream-types.js';

/** Where providers' services may live in this deployment (P-04, ADR-0029). Any session. */
@SignedIn()
@Controller('upstream-types')
export class UpstreamTypesController {
  @Get()
  @ApiOperation({
    operationId: 'listUpstreamTypes',
    summary: 'Upstream types new versions may use',
    description:
      "The country's features.upstreams, with xroad only where the deployment has the operator's " +
      'Security Server. Creating or revising a version with another type is a 400.',
    tags: ['apis'],
    responses: {
      200: { description: 'The allowed types, node first', schema: upstreamTypesSchema },
    },
    errors: [401],
  })
  list(): UpstreamTypes {
    return { allowed: allowedUpstreamTypes() };
  }
}
