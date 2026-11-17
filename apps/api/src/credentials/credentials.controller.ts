import { Body, Controller, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  applicationParamsSchema,
  credentialParamsSchema,
  credentialSchema,
  type RevokeCredentialInput,
  revokeCredentialSchema,
  rotatedSecretSchema,
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
import { CredentialsService } from './credentials.service.js';

const idPipe = () => new ZodValidationPipe(z.uuid());

/** Rotation and revocation of application credentials (SPEC.md §4.3, M3-04). */
@Controller('entities/:entityId/applications/:applicationId/credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Post('secret')
  @EntityAccess('application.write')
  // The response carries a secret: it must never be cached anywhere.
  @Header('cache-control', 'no-store')
  @ApiOperation({
    operationId: 'rotateApplicationSecret',
    summary: 'Rotate the client secret: a new one, while the previous keeps working for a while',
    description:
      'Returns the new secret once. The previous secret becomes `rotating` and keeps working ' +
      'until its rotationEndsAt (lifecycle.credentialRotationDays); revoke it to end the window ' +
      'earlier. One rotation at a time (409 otherwise). Keycloak is updated by the reconciler.',
    tags: ['applications'],
    params: applicationParamsSchema,
    responses: { 201: { description: 'The new secret', schema: rotatedSecretSchema } },
    errors: [401, 403, 404, 409],
  })
  rotateSecret(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('applicationId', idPipe()) applicationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.credentials.rotateSecret(entity.entityId, principal, applicationId, request.id);
  }

  @Post(':credentialId/revoke')
  @HttpCode(200)
  @EntityAccess('application.write')
  @ApiOperation({
    operationId: 'revokeApplicationCredential',
    summary: 'Revoke a credential: it stops working at once',
    description:
      'A certificate (current or rotating) or a rotating secret. The gateway stops accepting a ' +
      'revoked certificate with the next OPA bundle (under 60 s); Keycloak stops accepting a ' +
      'revoked secret once the reconciler runs. The current secret cannot be revoked (409): ' +
      'rotate it first.',
    tags: ['applications'],
    params: credentialParamsSchema,
    body: revokeCredentialSchema,
    responses: { 200: { description: 'The revoked credential', schema: credentialSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  revoke(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('applicationId', idPipe()) applicationId: string,
    @Param('credentialId', idPipe()) credentialId: string,
    @Body(new ZodValidationPipe(revokeCredentialSchema)) body: RevokeCredentialInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.credentials.revoke(
      entity.entityId,
      principal,
      applicationId,
      credentialId,
      body,
      request.id,
    );
  }
}
