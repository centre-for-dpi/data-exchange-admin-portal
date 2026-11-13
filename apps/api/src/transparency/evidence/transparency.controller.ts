import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  transparencyCheckpointPageSchema,
  transparencyCheckpointParamsSchema,
  transparencyCheckpointSchema,
  type TransparencyCheckpointsQuery,
  transparencyCheckpointsQuerySchema,
  transparencyJwksSchema,
  transparencyReceiptSchema,
  transparencyVerificationSchema,
} from '@rid/contracts';
import { z } from 'zod';
import { PlatformAccess, Public } from '../../auth/decorators.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiOperation } from '../../openapi/api-operation.decorator.js';
import { TransparencyEvidenceService } from './transparency-evidence.service.js';

const recordParamsSchema = z.strictObject({ id: z.uuid() });

/**
 * Evidence of the transparency register (ADR-0016, MT-04).
 *
 * Public: the operator's keys and the checkpoints (hashes only, no personal data), so anyone can
 * follow the chain and check a receipt without trusting the portal. Receipts and the full
 * re-check are for the operator, the regulator and auditors; citizens get theirs in MT-05.
 */
@Controller('transparency')
export class TransparencyController {
  constructor(private readonly evidence: TransparencyEvidenceService) {}

  @Get('jwks')
  @Public()
  @ApiOperation({
    operationId: 'getTransparencyJwks',
    summary: 'Public keys that sign the checkpoints of the transparency register',
    description: 'Current and retired Ed25519 keys (RFC 7517), by kid.',
    tags: ['transparency'],
    authenticated: false,
    responses: { 200: { description: 'JSON Web Key Set', schema: transparencyJwksSchema } },
  })
  jwks() {
    return this.evidence.jwks();
  }

  @Get('checkpoints')
  @Public()
  @ApiOperation({
    operationId: 'listTransparencyCheckpoints',
    summary: 'Sealed batches of the transparency register, oldest first',
    description:
      'Each checkpoint links to the previous one by hash, is signed by the operator and ' +
      'time-stamped by an independent TSA. Hashes only.',
    tags: ['transparency'],
    authenticated: false,
    query: transparencyCheckpointsQuerySchema,
    responses: {
      200: { description: 'A page of checkpoints', schema: transparencyCheckpointPageSchema },
    },
    errors: [400],
  })
  checkpoints(
    @Query(new ZodValidationPipe(transparencyCheckpointsQuerySchema))
    query: TransparencyCheckpointsQuery,
  ) {
    return this.evidence.listCheckpoints(query);
  }

  @Get('checkpoints/:seq')
  @Public()
  @ApiOperation({
    operationId: 'getTransparencyCheckpoint',
    summary: 'One sealed batch of the transparency register',
    tags: ['transparency'],
    authenticated: false,
    params: transparencyCheckpointParamsSchema,
    responses: { 200: { description: 'The checkpoint', schema: transparencyCheckpointSchema } },
    errors: [400, 404],
  })
  checkpoint(
    @Param(new ZodValidationPipe(transparencyCheckpointParamsSchema)) params: { seq: number },
  ) {
    return this.evidence.checkpoint(params.seq);
  }

  @Get('records/:id/receipt')
  @PlatformAccess('audit.read')
  @ApiOperation({
    operationId: 'getTransparencyReceipt',
    summary: 'Verifiable receipt of one call in the transparency register',
    description:
      'The record, its audit path in the batch, the signed checkpoint and the TSA time-stamp. ' +
      'Check it offline with rid-verify-receipt. 409 while the record is not sealed yet.',
    tags: ['transparency'],
    params: recordParamsSchema,
    responses: { 200: { description: 'The receipt', schema: transparencyReceiptSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  receipt(@Param(new ZodValidationPipe(recordParamsSchema)) params: { id: string }) {
    return this.evidence.receipt(params.id);
  }

  @Get('verify')
  @PlatformAccess('audit.read')
  @ApiOperation({
    operationId: 'verifyTransparencyRegister',
    summary: 'Re-check the whole transparency register',
    description:
      'Checkpoint chain and signatures, every batch root, every time-stamp, and every record ' +
      'against its leaf: altered, deleted or inserted records and batches are reported.',
    tags: ['transparency'],
    responses: {
      200: { description: 'Verification result', schema: transparencyVerificationSchema },
    },
    errors: [401, 403],
  })
  verify() {
    return this.evidence.verify();
  }
}
