import { Controller, Get, Query } from '@nestjs/common';
import {
  exchangeMapSchema,
  type IndicatorsQuery,
  indicatorsQuerySchema,
  networkIndicatorsSchema,
} from '@den/contracts';
import { PlatformAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { IndicatorsService } from './indicators.service.js';

/** The network's indicators for the regulator and the operator (SPEC.md §8, M5-04). */
@Controller('network')
export class IndicatorsController {
  constructor(private readonly indicators: IndicatorsService) {}

  @Get('indicators')
  @PlatformAccess('network.indicators.read')
  @ApiOperation({
    operationId: 'getNetworkIndicators',
    summary: "The network's indicators for a period",
    description:
      'Successful calls, APIs with real use, time to first use, connected entities by month, ' +
      'approval time, gateway availability and manual steps avoided (SPEC.md §8). Production ' +
      'traffic only. Days in the country time zone; the last 30 days by default. 503 when the ' +
      'analytics store is not available; availability is null without Prometheus.',
    tags: ['indicators'],
    query: indicatorsQuerySchema,
    responses: { 200: { description: 'The indicators', schema: networkIndicatorsSchema } },
    errors: [400, 401, 403, 503],
  })
  network(@Query(new ZodValidationPipe(indicatorsQuerySchema)) query: IndicatorsQuery) {
    return this.indicators.network(query);
  }

  @Get('exchanges')
  @PlatformAccess('network.map.read')
  @ApiOperation({
    operationId: 'getExchangeMap',
    summary: 'Who exchanges data with whom: consumer entity → provider entity, with volume',
    description:
      'Production calls of the period by consumer and provider entity, and the active ' +
      'subscriptions between them. 503 when the analytics store is not available.',
    tags: ['indicators'],
    query: indicatorsQuerySchema,
    responses: { 200: { description: 'The map', schema: exchangeMapSchema } },
    errors: [400, 401, 403, 503],
  })
  exchanges(@Query(new ZodValidationPipe(indicatorsQuerySchema)) query: IndicatorsQuery) {
    return this.indicators.exchanges(query);
  }
}
