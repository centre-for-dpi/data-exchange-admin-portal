import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  createPurposeSchema,
  purposeAdminListSchema,
  purposeCodeParamsSchema,
  updatePurposeSchema,
} from '@den/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { PurposesService } from './purposes.service.js';

type CreateInput = z.output<typeof createPurposeSchema>;
type UpdateInput = z.output<typeof updatePurposeSchema>;

/** Operator console: the purpose catalogue (SPEC.md §3, §6; M2-10). */
@Controller('admin/purposes')
export class AdminPurposesController {
  constructor(private readonly purposes: PurposesService) {}

  @Get()
  @PlatformAccess('purpose.read')
  @ApiOperation({
    operationId: 'listCataloguePurposes',
    summary: 'Every purpose of the catalogue, inactive ones and their use included',
    tags: ['purposes'],
    responses: { 200: { description: 'The catalogue', schema: purposeAdminListSchema } },
    errors: [401, 403],
  })
  list() {
    return this.purposes.list();
  }

  @Post()
  @PlatformAccess('purpose.manage')
  @ApiOperation({
    operationId: 'createPurpose',
    summary: 'Add a purpose to the catalogue',
    tags: ['purposes'],
    body: createPurposeSchema,
    responses: { 201: { description: 'The catalogue', schema: purposeAdminListSchema } },
    errors: [400, 401, 403, 409],
  })
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createPurposeSchema)) body: CreateInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.purposes.create(principal, body, request.id);
  }

  @Put(':code')
  @PlatformAccess('purpose.manage')
  @ApiOperation({
    operationId: 'updatePurpose',
    summary: 'Edit a purpose the operator added',
    description: 'Purposes from the country configuration are edited there (409 here).',
    tags: ['purposes'],
    params: purposeCodeParamsSchema,
    body: updatePurposeSchema,
    responses: { 200: { description: 'The catalogue', schema: purposeAdminListSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('code', new ZodValidationPipe(purposeCodeParamsSchema.shape.code)) code: string,
    @Body(new ZodValidationPipe(updatePurposeSchema)) body: UpdateInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.purposes.update(principal, code, body, request.id);
  }

  @Post(':code/deactivate')
  @HttpCode(200)
  @PlatformAccess('purpose.manage')
  @ApiOperation({
    operationId: 'deactivatePurpose',
    summary: 'Stop offering a purpose for new versions and requests',
    description: 'Subscriptions that already use it keep it.',
    tags: ['purposes'],
    params: purposeCodeParamsSchema,
    responses: { 200: { description: 'The catalogue', schema: purposeAdminListSchema } },
    errors: [401, 403, 404, 409],
  })
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('code', new ZodValidationPipe(purposeCodeParamsSchema.shape.code)) code: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.purposes.setActive(principal, code, false, request.id);
  }

  @Post(':code/activate')
  @HttpCode(200)
  @PlatformAccess('purpose.manage')
  @ApiOperation({
    operationId: 'activatePurpose',
    summary: 'Offer a deactivated purpose again',
    tags: ['purposes'],
    params: purposeCodeParamsSchema,
    responses: { 200: { description: 'The catalogue', schema: purposeAdminListSchema } },
    errors: [401, 403, 404, 409],
  })
  activate(
    @CurrentPrincipal() principal: Principal,
    @Param('code', new ZodValidationPipe(purposeCodeParamsSchema.shape.code)) code: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.purposes.setActive(principal, code, true, request.id);
  }
}
