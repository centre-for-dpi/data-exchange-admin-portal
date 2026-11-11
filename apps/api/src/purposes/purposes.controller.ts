import { Controller, Get } from '@nestjs/common';
import { purposeListSchema } from '@rid/contracts';
import type { z } from 'zod';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Purpose catalogue (SPEC.md §3). Readable by any authenticated user. */
@Controller('purposes')
export class PurposesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    operationId: 'listPurposes',
    summary: 'Active purposes of the catalogue',
    tags: ['purposes'],
    responses: { 200: { description: 'The catalogue', schema: purposeListSchema } },
    errors: [401],
  })
  async list(): Promise<z.infer<typeof purposeListSchema>> {
    const rows = await this.prisma.purpose.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
    });
    return {
      items: rows.map((p) => ({
        code: p.code,
        name: p.name as z.infer<typeof purposeListSchema>['items'][number]['name'],
        description: p.description as z.infer<
          typeof purposeListSchema
        >['items'][number]['description'],
        legalReference: p.legalReference,
      })),
    };
  }
}
