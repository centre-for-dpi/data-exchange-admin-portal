import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  invitationIdParamsSchema,
  invitationListSchema,
  membershipSummarySchema,
} from '@rid/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, SignedIn } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { InvitationsService } from './invitations.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/** The caller's invitations, matched by verified e-mail (ADR-0018). */
@SignedIn()
@Controller('me/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @ApiOperation({
    operationId: 'listMyInvitations',
    summary: 'Pending invitations to the caller’s verified e-mail',
    tags: ['session'],
    responses: { 200: { description: 'The invitations', schema: invitationListSchema } },
    errors: [401, 403],
  })
  mine(@CurrentPrincipal() principal: Principal) {
    return this.invitations.mine(principal);
  }

  @Post(':invitationId/accept')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'acceptInvitation',
    summary: 'Join the entity with the invited roles',
    description:
      'Only for a user whose verified e-mail is the invited address; any other caller gets 404.',
    tags: ['session'],
    params: invitationIdParamsSchema,
    responses: { 200: { description: 'The new membership', schema: membershipSummarySchema } },
    errors: [401, 403, 404, 409],
  })
  accept(
    @Param('invitationId', uuid) invitationId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.invitations.accept(invitationId, principal, request.id);
  }

  @Post(':invitationId/decline')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'declineInvitation',
    summary: 'Decline an invitation',
    tags: ['session'],
    params: invitationIdParamsSchema,
    responses: { 204: { description: 'Declined' } },
    errors: [401, 403, 404, 409],
  })
  async decline(
    @Param('invitationId', uuid) invitationId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.invitations.decline(invitationId, principal, request.id);
  }
}
