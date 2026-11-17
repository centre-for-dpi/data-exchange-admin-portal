import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import {
  type PutSubjectAlerts,
  putSubjectAlertsSchema,
  subjectAlertsSchema,
  subjectAccessesQuerySchema,
  type SubjectAccessesQuery,
  subjectAccessPageSchema,
  transparencyReceiptSchema,
} from '@den/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiOperation } from '../../openapi/api-operation.decorator.js';
import type { CitizenIdentity } from './citizen-token-verifier.js';
import { CitizenAccess, CurrentCitizen } from './citizen.guard.js';
import { SubjectAlertsService } from '../alerts/subject-alerts.service.js';
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
  constructor(
    private readonly dataSubjects: DataSubjectsService,
    private readonly alerts: SubjectAlertsService,
  ) {}

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
      'Check it offline with den-verify-receipt, the operator JWKS and the TSA certificate. ' +
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

  @Get('alerts')
  @ApiOperation({
    operationId: 'getMyDataAlerts',
    summary: 'My notices of new consultations of my data',
    description:
      'Which data classifications trigger a notice to the citizen app, and the opaque id the ' +
      'app receives in each webhook. Citizen token only.',
    tags: ['data-subjects'],
    authenticated: 'citizen',
    responses: { 200: { description: 'Current notices', schema: subjectAlertsSchema } },
    errors: [401],
  })
  getAlerts(@CurrentCitizen() citizen: CitizenIdentity) {
    return this.alerts.get(citizen);
  }

  @Put('alerts')
  @ApiOperation({
    operationId: 'putMyDataAlerts',
    summary: 'Choose which consultations of my data I am notified about',
    description:
      'personal and/or sensitive; an empty list turns notices off. Each new matching ' +
      'consultation sends a signed webhook (Standard Webhooks) to the citizen app with only the ' +
      'opaque alert id and the consultation id.',
    tags: ['data-subjects'],
    authenticated: 'citizen',
    body: putSubjectAlertsSchema,
    responses: { 200: { description: 'Notices saved', schema: subjectAlertsSchema } },
    errors: [400, 401],
  })
  putAlerts(
    @CurrentCitizen() citizen: CitizenIdentity,
    @Body(new ZodValidationPipe(putSubjectAlertsSchema)) body: PutSubjectAlerts,
  ) {
    return this.alerts.put(citizen, body.classifications);
  }
}
