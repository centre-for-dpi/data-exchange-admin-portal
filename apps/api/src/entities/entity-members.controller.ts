import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  type EntityRole,
  entityIdParamsSchema,
  entityInvitationListSchema,
  entityInvitationParamsSchema,
  entityInvitationSchema,
  entityMemberParamsSchema,
  entityMemberSchema,
  inviteMemberSchema,
  updateMemberRolesSchema,
} from '@rid/contracts';
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
import { MembersService } from './members.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/** Members and invitations of an entity, managed by its entity_admin (SPEC.md §2.2, M2-02). */
@Controller('entities/:entityId')
export class EntityMembersController {
  constructor(private readonly members: MembersService) {}

  @Get('invitations')
  @EntityAccess('entity.members.read')
  @ApiOperation({
    operationId: 'listEntityInvitations',
    summary: 'Invitations sent on behalf of the entity',
    tags: ['entities'],
    params: entityIdParamsSchema,
    responses: { 200: { description: 'The invitations', schema: entityInvitationListSchema } },
    errors: [401, 403, 404],
  })
  invitations(@CurrentEntity() entity: EntityContext) {
    return this.members.listInvitations(entity);
  }

  @Post('invitations')
  @EntityAccess('entity.members.write')
  @ApiOperation({
    operationId: 'inviteEntityMember',
    summary: 'Invite a person by e-mail with the given roles',
    description:
      'The invitation is e-mailed; only a user whose verified e-mail is that address can accept ' +
      'it (ADR-0018). It expires after RID_INVITATION_TTL_DAYS days.',
    tags: ['entities'],
    params: entityIdParamsSchema,
    body: inviteMemberSchema,
    responses: { 201: { description: 'The invitation', schema: entityInvitationSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  invite(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(inviteMemberSchema))
    body: { email: string; fullName?: string; roles: EntityRole[] },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.members.invite(entity, principal, body, request.id);
  }

  @Post('invitations/:invitationId/revoke')
  @HttpCode(200)
  @EntityAccess('entity.members.write')
  @ApiOperation({
    operationId: 'revokeEntityInvitation',
    summary: 'Withdraw a pending invitation',
    tags: ['entities'],
    params: entityInvitationParamsSchema,
    responses: { 200: { description: 'The invitation', schema: entityInvitationSchema } },
    errors: [401, 403, 404, 409],
  })
  revokeInvitation(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invitationId', uuid) invitationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.members.revokeInvitation(entity, principal, invitationId, request.id);
  }

  @Put('members/:membershipId/roles')
  @EntityAccess('entity.members.write')
  @ApiOperation({
    operationId: 'updateEntityMemberRoles',
    summary: 'Replace the roles of a member',
    description: 'The entity must keep at least one active entity_admin (409 otherwise).',
    tags: ['entities'],
    params: entityMemberParamsSchema,
    body: updateMemberRolesSchema,
    responses: { 200: { description: 'The member', schema: entityMemberSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  updateRoles(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId', uuid) membershipId: string,
    @Body(new ZodValidationPipe(updateMemberRolesSchema)) body: { roles: EntityRole[] },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.members.updateRoles(entity, principal, membershipId, body.roles, request.id);
  }

  @Post('members/:membershipId/revoke')
  @HttpCode(200)
  @EntityAccess('entity.members.write')
  @ApiOperation({
    operationId: 'revokeEntityMember',
    summary: 'Revoke a membership',
    description:
      'Effective on the member’s next request: roles are read from the database every time ' +
      '(ADR-0004). The entity must keep at least one active entity_admin.',
    tags: ['entities'],
    params: entityMemberParamsSchema,
    responses: { 200: { description: 'The member', schema: entityMemberSchema } },
    errors: [401, 403, 404, 409],
  })
  revoke(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId', uuid) membershipId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.members.revoke(entity, principal, membershipId, request.id);
  }
}
