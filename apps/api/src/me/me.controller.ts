import { Controller, Get } from '@nestjs/common';
import { type MeResponse, meResponseSchema } from '@den/contracts';
import { CurrentPrincipal, SignedIn } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';

@SignedIn()
@Controller('me')
export class MeController {
  @Get()
  @ApiOperation({
    operationId: 'getMe',
    summary: 'Current user, platform roles and active memberships',
    description:
      'Roles are read from the portal database on every request (ADR-0004); a revoked membership ' +
      'disappears on the next call. The first call of a new Keycloak user registers it without roles. ' +
      '`mfa` says whether the roles need a second factor and whether this session has it (M3-08).',
    tags: ['session'],
    responses: { 200: { description: 'The caller', schema: meResponseSchema } },
    errors: [401, 403],
  })
  me(@CurrentPrincipal() principal: Principal): MeResponse {
    return {
      user: { id: principal.userId, email: principal.email, fullName: principal.fullName },
      platformRoles: principal.platformRoles,
      memberships: principal.memberships.map((m) => ({
        entity: { id: m.entityId, slug: m.entitySlug, shortName: m.entityShortName },
        roles: m.roles,
      })),
      mfa: { required: principal.mfaRequired, satisfied: principal.mfa },
    };
  }
}
