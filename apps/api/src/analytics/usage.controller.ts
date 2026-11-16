import { Controller, Get, Query } from '@nestjs/common';
import {
  entityIdParamsSchema,
  providerUsageSchema,
  type UsageQuery,
  usageQuerySchema,
} from '@rid/contracts';
import { CurrentEntity, EntityAccess, type EntityContext } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { UsageService } from './usage.service.js';

/** Usage of an entity's APIs and applications, from the access logs (M5-02, M5-03). */
@Controller('entities/:entityId/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('provided')
  @EntityAccess('usage.provided.read')
  @ApiOperation({
    operationId: 'getProvidedUsage',
    summary: "Calls to the entity's APIs: by consumer, purpose, operation and answer code",
    description:
      'From the access logs (metadata only). Days in the country time zone; the last 30 days ' +
      'by default, at most 366. 503 when the analytics store is not available.',
    tags: ['usage'],
    params: entityIdParamsSchema,
    query: usageQuerySchema,
    responses: { 200: { description: 'The usage', schema: providerUsageSchema } },
    errors: [400, 401, 403, 404, 503],
  })
  provided(
    @CurrentEntity() entity: EntityContext,
    @Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery,
  ) {
    return this.usage.provided(entity.entityId, query);
  }
}
