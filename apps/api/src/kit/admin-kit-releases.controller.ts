import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import {
  KIT_BUNDLE_MEDIA_TYPE,
  kitReleaseListSchema,
  kitReleaseVersionParamsSchema,
  kitReleaseVersionSchema,
  setKitReleaseSchema,
} from '@den/contracts';
import type { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { UnsupportedMediaTypeError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { KitReleasesService } from './kit-releases.service.js';

const version = new ZodValidationPipe(kitReleaseVersionSchema);

/** Operator console: the node kit's current version and its mirror (P-03). */
@Controller('admin/kit-releases')
export class AdminKitReleasesController {
  constructor(private readonly releases: KitReleasesService) {}

  @Get()
  @PlatformAccess('kit_release.read')
  @ApiOperation({
    operationId: 'listKitReleases',
    summary: 'Every release of the node kit the operator has offered, newest first',
    tags: ['kit'],
    responses: { 200: { description: 'The releases', schema: kitReleaseListSchema } },
    errors: [401, 403],
  })
  list() {
    return this.releases.list();
  }

  @Put(':version')
  @PlatformAccess('kit_release.manage')
  @ApiOperation({
    operationId: 'setKitRelease',
    summary: 'Register or correct a release of the kit and make it the current version',
    description:
      'Idempotent. The link must be https and end in the bundle file name. Size and checksum of ' +
      'a mirrored release cannot change (409).',
    tags: ['kit'],
    params: kitReleaseVersionParamsSchema,
    body: setKitReleaseSchema,
    responses: { 200: { description: 'The releases', schema: kitReleaseListSchema } },
    errors: [400, 401, 403, 409],
  })
  set(
    @CurrentPrincipal() principal: Principal,
    @Param('version', version) releaseVersion: string,
    @Body(new ZodValidationPipe(setKitReleaseSchema)) body: z.output<typeof setKitReleaseSchema>,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.releases.set(principal, releaseVersion, body, request.id);
  }

  @Put(':version/bundle')
  @PlatformAccess('kit_release.manage')
  @ApiOperation({
    operationId: 'mirrorKitBundle',
    summary: 'Upload the bundle of a release, for the portal to serve under /kit/<version>/',
    description:
      'The body is the bundle itself (`Content-Type: application/gzip`), up to ' +
      'DEN_KIT_BUNDLE_MAX_BYTES (128 MiB by default). Accepted only with the size and SHA-256 ' +
      'of the release; once mirrored it never changes (409).',
    tags: ['kit'],
    params: kitReleaseVersionParamsSchema,
    binaryBody: KIT_BUNDLE_MEDIA_TYPE,
    responses: { 200: { description: 'The releases', schema: kitReleaseListSchema } },
    errors: [400, 401, 403, 404, 409, 413, 415],
  })
  mirror(
    @CurrentPrincipal() principal: Principal,
    @Param('version', version) releaseVersion: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!Buffer.isBuffer(body)) {
      throw new UnsupportedMediaTypeError('Send the bundle as application/gzip');
    }
    return this.releases.mirror(principal, releaseVersion, body, request.id);
  }
}
