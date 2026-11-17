import { Body, Controller, Get, Header, Post, Req } from '@nestjs/common';
import {
  gatewayJwksSchema,
  gatewaySigningKeyRotatedSchema,
  type RotateGatewaySigningKeyInput,
  rotateGatewaySigningKeySchema,
} from '@rid/contracts';
import {
  type AuthenticatedRequest,
  CurrentPrincipal,
  PlatformAccess,
  Public,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { GatewaySigningKeysService } from './gateway-signing-keys.service.js';

/** The gateway's signed assertion to providers (ADR-0024, M6-10): its public keys. */
@Controller('gateway')
export class GatewayController {
  constructor(private readonly keys: GatewaySigningKeysService) {}

  @Get('jwks')
  @Public()
  // Providers cache it; a new key is listed before it signs anything (the reconciler pushes it
  // after it exists here), and an unknown kid sends them back for a fresh copy.
  @Header('cache-control', 'public, max-age=300')
  @ApiOperation({
    operationId: 'getGatewayJwks',
    summary: 'Public keys of the assertions the gateway signs for providers',
    description:
      'ES256 keys (RFC 7517) by kid, newest first: every key ever used, so archived assertions ' +
      'keep verifying, except a compromised one. Providers verify X-RID-Assertion with them.',
    tags: ['gateway'],
    authenticated: false,
    responses: { 200: { description: 'JSON Web Key Set', schema: gatewayJwksSchema } },
  })
  jwks() {
    return this.keys.jwks();
  }
}

/** Operator console: rotate the signing key now, for instance after a compromise (RUNBOOK.md). */
@Controller('admin/gateway-signing-keys')
export class AdminGatewaySigningKeysController {
  constructor(private readonly keys: GatewaySigningKeysService) {}

  @Post('rotate')
  @PlatformAccess('gateway_key.rotate')
  @ApiOperation({
    operationId: 'rotateGatewaySigningKey',
    summary: 'Rotate the signing key of the gateway’s assertions now',
    description:
      'A new key signs from the gateway’s next pass (queued at once). With `compromised`, the ' +
      'previous key leaves the JWKS and what it signed no longer verifies.',
    tags: ['gateway'],
    body: rotateGatewaySigningKeySchema,
    responses: { 201: { description: 'The new key', schema: gatewaySigningKeyRotatedSchema } },
    errors: [400, 401, 403],
  })
  rotate(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(rotateGatewaySigningKeySchema)) body: RotateGatewaySigningKeyInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.keys.rotate(principal, body, request.id);
  }
}
