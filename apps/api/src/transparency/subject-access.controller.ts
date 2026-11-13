import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { type IngestResult, SubjectAccessService } from './subject-access.service.js';

export const SUBJECT_ACCESS_PATH = 'internal/subject-access';
/** Fluent Bit flushes a whole chunk per request; larger than the API's default JSON limit. */
export const SUBJECT_ACCESS_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/** Fluent Bit's http output (format json): an array of records. Each one is checked apart. */
const batchSchema = z.array(z.unknown()).max(100_000);

/**
 * Whether an Authorization header carries the ingest service token (timing-safe). An unset token
 * matches nothing (fail closed). Also checked before the body is read (onRequest hook in app.ts),
 * so an unauthenticated caller cannot make the API buffer and parse large bodies.
 */
export function ingestTokenMatches(authorization: string | undefined): boolean {
  const expected = process.env.RID_TRANSPARENCY_INGEST_TOKEN ?? '';
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return expected !== '' && a.length === b.length && timingSafeEqual(a, b);
}

const ingestResultSchema = z.object({
  accepted: z.number(),
  duplicates: z.number(),
  dropped: z.record(z.string(), z.number()),
});

/**
 * Collector of the transparency register (ADR-0015, ARCHITECTURE.md §13), for the Fluent Bit of
 * the gateways only: service token RID_TRANSPARENCY_INGEST_TOKEN, internal network. A record that
 * does not add up is dropped and counted, never rejected with the batch: a 4xx would make Fluent
 * Bit retry the same chunk forever. Errors of the database answer 5xx, so Fluent Bit retries.
 */
@Controller(SUBJECT_ACCESS_PATH)
@Public()
export class SubjectAccessController {
  constructor(private readonly service: SubjectAccessService) {}

  private authorize(authorization: string | undefined): void {
    if (!ingestTokenMatches(authorization)) throw new UnauthorizedException();
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: 'ingestSubjectAccessRecords',
    summary: 'Transparency register: records of calls per data subject from the gateway',
    description:
      'For the gateways’ Fluent Bit only (Bearer RID_TRANSPARENCY_INGEST_TOKEN, internal ' +
      'network). Insert-only and idempotent; records that do not match an authorized ' +
      'subscription are dropped and counted.',
    tags: ['transparency'],
    authenticated: false,
    body: batchSchema,
    responses: { 200: { description: 'Counts per outcome', schema: ingestResultSchema } },
    errors: [400, 401],
  })
  async ingest(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<IngestResult> {
    // The token first: an unauthenticated caller learns nothing, not even the body shape.
    this.authorize(authorization);
    return this.service.ingest(new ZodValidationPipe(batchSchema).transform(body));
  }
}
