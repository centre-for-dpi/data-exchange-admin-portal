import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  deprecateVersionSchema,
  setVersionPurposesSchema,
  type ApiDetail,
  apiDetailSchema,
  apiPageSchema,
  apiParamsSchema,
  type ApiVersionDetail,
  apiVersionDetailSchema,
  apiVersionParamsSchema,
  type CreateApiInput,
  createApiSchema,
  type CreateApiVersionInput,
  createApiVersionSchema,
  entityIdParamsSchema,
  hostProofSchema,
  type PaginationQuery,
  paginationQuerySchema,
  replaceOpenapiSchema,
  updateApiVersionSchema,
  type UpdateApiVersionInput,
} from '@den/contracts';
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
import { ApisService } from './apis.service.js';

const uuid = new ZodValidationPipe(z.uuid());

@Controller('entities/:entityId/apis')
export class ApisController {
  constructor(private readonly apis: ApisService) {}

  @Get()
  @EntityAccess('api.read')
  @ApiOperation({
    operationId: 'listEntityApis',
    summary: 'APIs registered by the entity',
    tags: ['apis'],
    params: entityIdParamsSchema,
    query: paginationQuerySchema,
    responses: { 200: { description: 'A page of APIs', schema: apiPageSchema } },
    errors: [400, 401, 403, 404],
  })
  list(
    @CurrentEntity() entity: EntityContext,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.apis.list(entity.entityId, query);
  }

  @Post()
  @EntityAccess('api.write')
  @ApiOperation({
    operationId: 'createApi',
    summary: 'Register an API (draft)',
    tags: ['apis'],
    params: entityIdParamsSchema,
    body: createApiSchema,
    responses: { 201: { description: 'The new API', schema: apiDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  create(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createApiSchema)) body: CreateApiInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiDetail> {
    return this.apis.create(entity.entityId, principal, body, request.id);
  }

  @Get(':apiId')
  @EntityAccess('api.read')
  @ApiOperation({
    operationId: 'getEntityApi',
    summary: 'API with its versions',
    tags: ['apis'],
    params: apiParamsSchema,
    responses: { 200: { description: 'The API', schema: apiDetailSchema } },
    errors: [401, 403, 404],
  })
  get(@CurrentEntity() entity: EntityContext, @Param('apiId', uuid) apiId: string) {
    return this.apis.get(entity.entityId, apiId);
  }

  @Post(':apiId/versions')
  @EntityAccess('api.write')
  @ApiOperation({
    operationId: 'createApiVersion',
    summary: 'Upload a new version (draft); the OpenAPI document is linted',
    description:
      'The OpenAPI 3.x document goes as YAML or JSON text in `openapi`. The lint report is returned ' +
      'and stored; a version with lint errors stays in draft and cannot be submitted.',
    tags: ['apis'],
    params: apiParamsSchema,
    body: createApiVersionSchema,
    responses: { 201: { description: 'The new version', schema: apiVersionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  createVersion(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('apiId', uuid) apiId: string,
    @Body(new ZodValidationPipe(createApiVersionSchema)) body: CreateApiVersionInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiVersionDetail> {
    return this.apis.createVersion(entity.entityId, apiId, principal, body, request.id);
  }

  @Get(':apiId/versions/:versionId')
  @EntityAccess('api.read')
  @ApiOperation({
    operationId: 'getApiVersion',
    summary: 'Version details with its lint report',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    responses: { 200: { description: 'The version', schema: apiVersionDetailSchema } },
    errors: [401, 403, 404],
  })
  getVersion(
    @CurrentEntity() entity: EntityContext,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
  ) {
    return this.apis.getVersion(entity.entityId, apiId, versionId);
  }

  @Get(':apiId/versions/:versionId/openapi')
  @EntityAccess('api.read')
  @ApiOperation({
    operationId: 'getApiVersionOpenapi',
    summary: 'OpenAPI document of the version',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    responses: {
      200: { description: 'OpenAPI 3.x document', schema: z.record(z.string(), z.unknown()) },
    },
    errors: [401, 403, 404],
  })
  getOpenapi(
    @CurrentEntity() entity: EntityContext,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
  ) {
    return this.apis.getOpenapi(entity.entityId, apiId, versionId);
  }

  @Put(':apiId/versions/:versionId')
  @EntityAccess('api.write')
  @ApiOperation({
    operationId: 'updateApiVersion',
    summary: 'Replace what an editable version declares (draft or changes requested)',
    description:
      'Replaces the exposed fields, legal basis, purposes and upstreams, and the OpenAPI document ' +
      'when it is sent, with the validation of version creation. A version in review or beyond ' +
      'is a 409.',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    body: updateApiVersionSchema,
    responses: { 200: { description: 'The version', schema: apiVersionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  updateVersion(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
    @Body(new ZodValidationPipe(updateApiVersionSchema)) body: UpdateApiVersionInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.apis.updateVersion(entity.entityId, apiId, versionId, principal, body, request.id);
  }

  @Put(':apiId/versions/:versionId/openapi')
  @EntityAccess('api.write')
  @ApiOperation({
    operationId: 'replaceApiVersionOpenapi',
    summary: 'Replace the OpenAPI document of an editable version, or revise a published one',
    description:
      'On a draft: replaces and lints again. On a published version (ADR-0019): a compatible ' +
      'revision that moves it to the next minor, on the same route and subscriptions; an ' +
      'incompatible change is a 400 that asks for a new major version.',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    body: replaceOpenapiSchema,
    responses: {
      200: { description: 'The version, linted again', schema: apiVersionDetailSchema },
    },
    errors: [400, 401, 403, 404, 409],
  })
  replaceOpenapi(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
    @Body(new ZodValidationPipe(replaceOpenapiSchema)) body: { openapi: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.apis.replaceOpenapi(
      entity.entityId,
      apiId,
      versionId,
      principal,
      body.openapi,
      request.id,
    );
  }

  @Post(':apiId/versions/:versionId/submit')
  @HttpCode(200)
  @EntityAccess('api.write')
  @ApiOperation({
    operationId: 'submitApiVersion',
    summary: 'Send a version to review (draft -> in_review)',
    description: 'Fails with 400 while the OpenAPI lint has errors, 409 from any other state.',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    responses: {
      200: { description: 'The version, now in review', schema: apiVersionDetailSchema },
    },
    errors: [400, 401, 403, 404, 409],
  })
  submit(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.apis.submit(entity.entityId, apiId, versionId, principal, request.id);
  }

  @Get(':apiId/versions/:versionId/host-proof')
  @EntityAccess('api.read')
  @ApiOperation({
    operationId: 'getApiVersionHostProof',
    summary: 'What the sandbox host must serve for the contract test to run',
    description:
      'For a version whose sandbox upstream is a `direct` host: the URL (/.well-known/den-validation ' +
      'on that host) and the exact text it must answer with. Without it, the contract test of the ' +
      'validations fails with "host control not proven".',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    responses: { 200: { description: 'The proof', schema: hostProofSchema } },
    errors: [401, 403, 404],
  })
  getHostProof(
    @CurrentEntity() entity: EntityContext,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
  ) {
    return this.apis.hostProof(entity.entityId, apiId, versionId);
  }

  @Post(':apiId/versions/:versionId/validations')
  @HttpCode(200)
  @EntityAccess('api.write')
  @ApiOperation({
    operationId: 'revalidateApiVersion',
    summary: 'Run the automatic validations of a version in review again',
    description:
      'Healthcheck of the upstream through the gateway and contract test (Schemathesis) of the ' +
      'sandbox upstream (M4-06). The operator approves only when they passed. A `direct` sandbox ' +
      "host must prove it is the provider's (see the host proof); asking again is limited by a " +
      'cooldown per version and a cap per entity and hour (429).',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    responses: { 200: { description: 'The version', schema: apiVersionDetailSchema } },
    errors: [401, 403, 404, 409, 429],
  })
  revalidate(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.apis.revalidate(entity.entityId, apiId, versionId, principal, request.id);
  }

  @Post(':apiId/versions/:versionId/deprecate')
  @HttpCode(200)
  @EntityAccess('api.write')
  @ApiOperation({
    operationId: 'deprecateApiVersion',
    summary: 'Deprecate a published version with its retirement date',
    description:
      'The date must respect lifecycle.apiRetirementNoticeDays of the country config. Until then ' +
      'the gateway answers with Deprecation and Sunset headers and no new access requests are ' +
      'accepted; on that date the version is retired and its subscriptions revoked (ADR-0019).',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    body: deprecateVersionSchema,
    responses: { 200: { description: 'The version', schema: apiVersionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  deprecate(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
    @Body(new ZodValidationPipe(deprecateVersionSchema)) body: { sunsetAt: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.apis.deprecate(
      entity.entityId,
      apiId,
      versionId,
      principal,
      new Date(body.sunsetAt),
      request.id,
    );
  }

  @Put(':apiId/versions/:versionId/purposes')
  @EntityAccess('api.purposes.write')
  @ApiOperation({
    operationId: 'setApiVersionPurposes',
    summary: 'Choose the catalogue purposes a version allows (data steward)',
    description:
      'Only active purposes. Subscriptions already granted keep their purpose; only new ' +
      'requests use the new list.',
    tags: ['apis'],
    params: apiVersionParamsSchema,
    body: setVersionPurposesSchema,
    responses: { 200: { description: 'The version', schema: apiVersionDetailSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  setPurposes(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('apiId', uuid) apiId: string,
    @Param('versionId', uuid) versionId: string,
    @Body(new ZodValidationPipe(setVersionPurposesSchema)) body: { allowedPurposes: string[] },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.apis.setPurposes(
      entity.entityId,
      apiId,
      versionId,
      principal,
      body.allowedPurposes,
      request.id,
    );
  }
}
