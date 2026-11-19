import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  platformRoleChangeSchema,
  platformRoleHolderListSchema,
  platformRoleResultSchema,
  userStatusChangeSchema,
  userStatusResultSchema,
} from '@den/contracts';
import type { z } from 'zod';
import { CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { PlatformUsersService } from './platform-users.service.js';

/**
 * Operator console: platform roles and account status (M-03). Platform administrators only, with
 * the second factor; every change is audited in its transaction with the reason given. The
 * server's command line (`install.sh platform-role`) stays for the first administrator and for
 * recovery.
 */
@Controller('admin')
export class PlatformUsersController {
  constructor(private readonly users: PlatformUsersService) {}

  @Get('platform-roles')
  @PlatformAccess('platform_role.read')
  @ApiOperation({
    operationId: 'listPlatformRoleHolders',
    summary: 'Who holds each platform role',
    tags: ['admin'],
    responses: { 200: { description: 'The holders', schema: platformRoleHolderListSchema } },
    errors: [401, 403],
  })
  holders() {
    return this.users.holders();
  }

  @Post('platform-roles/grant')
  @HttpCode(200)
  @PlatformAccess('platform_role.manage')
  @ApiOperation({
    operationId: 'grantPlatformRole',
    summary: 'Grant a platform role to a person with an active account',
    description:
      'The person must have registered, verified the e-mail and signed in once. Audited ' +
      '(`platform_role.granted`) with the reason. A role already held changes nothing. The ' +
      'second factor is asked at the person’s next sign-in.',
    tags: ['admin'],
    body: platformRoleChangeSchema,
    responses: { 200: { description: 'The outcome', schema: platformRoleResultSchema } },
    errors: [400, 401, 403, 409],
  })
  grant(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(platformRoleChangeSchema))
    body: z.output<typeof platformRoleChangeSchema>,
  ) {
    return this.users.grant(body, principal);
  }

  @Post('platform-roles/revoke')
  @HttpCode(200)
  @PlatformAccess('platform_role.manage')
  @ApiOperation({
    operationId: 'revokePlatformRole',
    summary: 'Revoke a platform role',
    description:
      'Audited (`platform_role.revoked`) with the reason. The last active `platform_admin` ' +
      'cannot lose the role (409).',
    tags: ['admin'],
    body: platformRoleChangeSchema,
    responses: { 200: { description: 'The outcome', schema: platformRoleResultSchema } },
    errors: [400, 401, 403, 409],
  })
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(platformRoleChangeSchema))
    body: z.output<typeof platformRoleChangeSchema>,
  ) {
    return this.users.revoke(body, principal);
  }

  @Post('users/disable')
  @HttpCode(200)
  @PlatformAccess('platform_role.manage')
  @ApiOperation({
    operationId: 'disableUser',
    summary: 'Disable a portal account',
    description:
      'From the next request every API call of the account answers 403 and it gets no notices; ' +
      'its memberships and roles stay, inert. Audited (`user.disabled`). The Keycloak user is ' +
      'not touched. The last active `platform_admin` cannot be disabled (409).',
    tags: ['admin'],
    body: userStatusChangeSchema,
    responses: { 200: { description: 'The outcome', schema: userStatusResultSchema } },
    errors: [400, 401, 403, 409],
  })
  disable(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(userStatusChangeSchema))
    body: z.output<typeof userStatusChangeSchema>,
  ) {
    return this.users.setStatus(body, 'disabled', principal);
  }

  @Post('users/enable')
  @HttpCode(200)
  @PlatformAccess('platform_role.manage')
  @ApiOperation({
    operationId: 'enableUser',
    summary: 'Enable a disabled portal account',
    description: 'Audited (`user.enabled`). Its memberships and roles work again at once.',
    tags: ['admin'],
    body: userStatusChangeSchema,
    responses: { 200: { description: 'The outcome', schema: userStatusResultSchema } },
    errors: [400, 401, 403],
  })
  enable(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(userStatusChangeSchema))
    body: z.output<typeof userStatusChangeSchema>,
  ) {
    return this.users.setStatus(body, 'active', principal);
  }
}
