import { Controller, Get, Param, Res } from '@nestjs/common';
import {
  currentKitReleaseSchema,
  KIT_BUNDLE_MEDIA_TYPE,
  kitReleaseVersionSchema,
} from '@den/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { KitReleasesService } from './kit-releases.service.js';

const fileParamsSchema = z.object({
  version: kitReleaseVersionSchema,
  file: z.string().max(200),
});

/** A versioned path serves the same bytes for good: the bundle is accepted once, checked. */
export const KIT_MIRROR_CACHE = 'public, max-age=31536000, immutable';

/**
 * The node kit for anyone (P-03): the version the operator offers now and, when it mirrors the
 * bundle, the file itself. Entities that are not onboarded yet read it on the public site, and a
 * server that cannot reach GitHub downloads it from the portal. Nothing here is secret: enrolling
 * a node takes the token, which the portal never shows twice.
 */
@Public()
@Controller('kit')
export class KitController {
  constructor(private readonly releases: KitReleasesService) {}

  @Get('current')
  @ApiOperation({
    operationId: 'getCurrentKitRelease',
    summary: 'The current version of the node kit: link, size, SHA-256 and signature',
    description:
      'The checksum is a convenience: whoever controls the portal controls both the file and ' +
      'its checksum. The guarantee is the operator signature, with a key delivered through ' +
      'another channel. `release` is null until the operator sets a version.',
    tags: ['kit'],
    authenticated: false,
    responses: { 200: { description: 'The current release', schema: currentKitReleaseSchema } },
  })
  current() {
    return this.releases.current();
  }

  @Get('releases/:version/:file')
  @ApiOperation({
    operationId: 'downloadMirroredKitFile',
    summary: 'A mirrored bundle of the kit, or its `.sha256` file',
    description:
      '`file` is the bundle file name, or that name followed by `.sha256` (the format ' +
      '`sha256sum -c` reads). The web serves the same under /kit/<version>/<file>.',
    tags: ['kit'],
    authenticated: false,
    params: fileParamsSchema,
    responses: { 200: { description: 'The file', binary: KIT_BUNDLE_MEDIA_TYPE } },
    errors: [400, 404],
  })
  async file(
    @Param(new ZodValidationPipe(fileParamsSchema)) params: z.output<typeof fileParamsSchema>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.releases.mirroredFile(params.version, params.file);
    reply
      .status(200)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', KIT_MIRROR_CACHE);
    if (file.kind === 'checksum') {
      await reply.header('content-type', 'text/plain; charset=utf-8').send(file.text);
      return;
    }
    await reply
      .header('content-type', KIT_BUNDLE_MEDIA_TYPE)
      .header('content-length', String(file.size))
      .send(file.stream);
  }
}
