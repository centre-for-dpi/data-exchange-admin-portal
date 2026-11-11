import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { ApiOperation } from '../openapi/api-operation.decorator.js';

export const healthSchema = z.object({ status: z.literal('ok') });
export type HealthStatus = z.infer<typeof healthSchema>;

@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    operationId: 'getHealth',
    summary: 'Liveness check',
    tags: ['system'],
    authenticated: false,
    responses: { 200: { description: 'The API process is up', schema: healthSchema } },
  })
  check(): HealthStatus {
    return { status: 'ok' };
  }
}
