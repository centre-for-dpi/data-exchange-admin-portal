import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { OpaService } from './opa.service.js';

/** Subset of OPA's status report (status plugin) the portal uses. */
const statusReportSchema = z.looseObject({
  bundles: z
    .record(z.string(), z.looseObject({ active_revision: z.string().max(200).optional() }))
    .optional(),
});
type StatusReport = z.infer<typeof statusReportSchema>;

export const BUNDLE_NAME = 'den';

/**
 * Endpoints for the gateways' OPA (ARCHITECTURE.md §4.2), authenticated with the service token
 * OPA_BUNDLE_TOKEN instead of a user JWT. The bundle carries the end-user hash salt: it must
 * only be reachable from the internal network.
 */
@Controller('opa')
@Public()
export class OpaController {
  constructor(private readonly opa: OpaService) {}

  private authorize(authorization: string | undefined): void {
    const expected = process.env.OPA_BUNDLE_TOKEN ?? '';
    const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    // An unset token rejects everyone (fail closed).
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException();
    }
  }

  @Get('bundle.tar.gz')
  @ApiOperation({
    operationId: 'getOpaBundle',
    summary: 'OPA bundle: den.authz policies and the data they decide on',
    description:
      'For the gateways’ OPA only (Bearer OPA_BUNDLE_TOKEN, internal network). Supports ' +
      'If-None-Match: the ETag is the bundle revision.',
    tags: ['opa'],
    authenticated: false,
    responses: {
      200: { description: 'gzip tar bundle' },
      304: { description: 'Unchanged since the given ETag' },
    },
    errors: [401],
  })
  async bundle(
    @Headers('authorization') authorization: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.authorize(authorization);
    const { archive, revision } = await this.opa.bundle();
    const etag = `"${revision}"`;
    void reply.header('etag', etag).header('cache-control', 'no-store');
    const known = (ifNoneMatch ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (known.includes(etag)) {
      await reply.status(304).send();
      return;
    }
    await reply.status(200).header('content-type', 'application/gzip').send(archive);
  }

  @Post('status')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'reportOpaStatus',
    summary: 'OPA status report: the bundle revision OPA activated',
    description:
      'Sent by OPA’s status plugin (Bearer OPA_BUNDLE_TOKEN). Approved subscriptions in the ' +
      'active revision become active.',
    tags: ['opa'],
    authenticated: false,
    body: statusReportSchema,
    responses: { 204: { description: 'Recorded' } },
    errors: [400, 401],
  })
  async status(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(statusReportSchema)) report: StatusReport,
  ): Promise<void> {
    this.authorize(authorization);
    const revision = report.bundles?.[BUNDLE_NAME]?.active_revision;
    if (revision) await this.opa.reportActiveRevision(revision);
  }
}
