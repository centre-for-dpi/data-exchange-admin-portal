import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  subjectAccessesQuerySchema,
  type SubjectAccessesQuery,
  subjectAccessPageSchema,
  transparencyReceiptSchema,
} from '@rid/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiOperation } from '../../openapi/api-operation.decorator.js';
import type { CitizenIdentity } from './citizen-token-verifier.js';
import { CitizenAccess, CurrentCitizen } from './citizen.guard.js';
import { DataSubjectsService } from './data-subjects.service.js';

const accessParamsSchema = z.strictObject({ id: z.uuid() });

/**
 * "Who consulted my data?" (ADR-0015, MT-05), for citizen apps such as the Carpeta Ciudadana.
 * Only with the citizen's own token: the portal derives who they are from the verified document
 * in the token and never takes a document number as input.
 */
@Controller('data-subjects/me')
@CitizenAccess()
export class DataSubjectsController {
  constructor(private readonly dataSubjects: DataSubjectsService) {}

  @Get('accesses')
  @ApiOperation({
    operationId: 'listMyDataAccesses',
    summary: 'Consultations of my data through the gateway, newest first',
    description:
      'Who consulted, when, which data, for what purpose and with which official (as an opaque ' +
      'reference). Citizen token only.',
    tags: ['data-subjects'],
    authenticated: 'citizen',
    query: subjectAccessesQuerySchema,
    responses: { 200: { description: 'A page of consultations', schema: subjectAccessPageSchema } },
    errors: [400, 401],
  })
  accesses(
    @CurrentCitizen() citizen: CitizenIdentity,
    @Query(new ZodValidationPipe(subjectAccessesQuerySchema)) query: SubjectAccessesQuery,
  ) {
    return this.dataSubjects.accesses(citizen.ref, query);
  }

  @Get('accesses/:id/receipt')
  @ApiOperation({
    operationId: 'getMyDataAccessReceipt',
    summary: 'Verifiable receipt of one consultation of my data',
    description:
      'Check it offline with rid-verify-receipt, the operator JWKS and the TSA certificate. ' +
      '404 for a consultation that is not about the caller; 409 while it is not sealed yet.',
    tags: ['data-subjects'],
    authenticated: 'citizen',
    params: accessParamsSchema,
    responses: { 200: { description: 'The receipt', schema: transparencyReceiptSchema } },
    errors: [400, 401, 404, 409],
  })
  receipt(
    @CurrentCitizen() citizen: CitizenIdentity,
    @Param(new ZodValidationPipe(accessParamsSchema)) params: { id: string },
  ) {
    return this.dataSubjects.receipt(citizen.ref, params.id);
  }
}
