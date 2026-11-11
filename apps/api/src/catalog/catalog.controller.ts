import { Controller, Get, Param, Query, Req, UnauthorizedException } from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import {
  catalogApiParamsSchema,
  catalogDetailSchema,
  catalogEntitiesSchema,
  catalogPageSchema,
  type CatalogQuery,
  catalogQuerySchema,
  catalogVersionParamsSchema,
} from '@rid/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, OptionalAuth } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { type CatalogViewer, CatalogService } from './catalog.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/**
 * Anonymous visitors may browse only when the country enables the public catalogue, and then only
 * public APIs (SPEC.md §2.3). Otherwise the catalogue requires authentication.
 */
function viewerOf(request: AuthenticatedRequest): CatalogViewer {
  if (request.principal) return { anonymous: false };
  if (!getCountryConfig().features.publicCatalog) {
    throw new UnauthorizedException('Sign in to browse the catalogue');
  }
  return { anonymous: true };
}

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('apis')
  @OptionalAuth()
  @ApiOperation({
    operationId: 'searchCatalog',
    summary: 'Search published APIs',
    description:
      'Free text over name, summary and tags; filters by sector, provider entity (slug) and ' +
      'classification. Anonymous access only with features.publicCatalog, limited to public APIs.',
    tags: ['catalog'],
    query: catalogQuerySchema,
    responses: { 200: { description: 'A page of APIs', schema: catalogPageSchema } },
    errors: [400, 401],
    authenticated: false,
  })
  search(
    @Query(new ZodValidationPipe(catalogQuerySchema)) query: CatalogQuery,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.catalog.list(query, viewerOf(request));
  }

  @Get('entities')
  @OptionalAuth()
  @ApiOperation({
    operationId: 'listCatalogEntities',
    summary: 'Provider entities with published APIs',
    tags: ['catalog'],
    responses: { 200: { description: 'Entities', schema: catalogEntitiesSchema } },
    errors: [401],
    authenticated: false,
  })
  entities(@Req() request: AuthenticatedRequest) {
    return this.catalog.entities(viewerOf(request));
  }

  @Get('apis/:apiId')
  @OptionalAuth()
  @ApiOperation({
    operationId: 'getCatalogApi',
    summary: 'Service sheet of a published API',
    tags: ['catalog'],
    params: catalogApiParamsSchema,
    responses: { 200: { description: 'The API', schema: catalogDetailSchema } },
    errors: [401, 404],
    authenticated: false,
  })
  detail(@Param('apiId', uuid) apiId: string, @Req() request: AuthenticatedRequest) {
    return this.catalog.detail(apiId, viewerOf(request));
  }

  @Get('apis/:apiId/versions/:versionId/openapi')
  @OptionalAuth()
  @ApiOperation({
    operationId: 'getCatalogOpenapi',
    summary: 'OpenAPI of a published version, with the gateway as server',
    tags: ['catalog'],
    params: catalogVersionParamsSchema,
    responses: {
      200: { description: 'OpenAPI 3.x document', schema: z.record(z.string(), z.unknown()) },
    },
    errors: [401, 404],
    authenticated: false,
  })
  openapi(
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.catalog.openapi(apiId, versionId, viewerOf(request));
  }
}
