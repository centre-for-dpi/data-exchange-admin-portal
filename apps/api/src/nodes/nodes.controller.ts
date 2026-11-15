import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  type CreateNodeInput,
  createNodeSchema,
  enrollmentTokenParamsSchema,
  entityIdParamsSchema,
  issuedEnrollmentTokenSchema,
  networkNodeListSchema,
  nodeDetailSchema,
  nodeIdParamsSchema,
  nodeListSchema,
} from '@rid/contracts';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  CurrentEntity,
  CurrentPrincipal,
  EntityAccess,
  type EntityContext,
  PlatformAccess,
} from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { NodesService } from './nodes.service.js';

const uuid = new ZodValidationPipe(z.uuid());

/** Nodes of the kit of an entity and their enrollment tokens (SPEC.md §4.6, M4-01). */
@Controller('entities/:entityId/nodes')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get()
  @EntityAccess('node.read')
  @ApiOperation({
    operationId: 'listNodes',
    summary: 'Nodes of the kit of the entity',
    tags: ['nodes'],
    params: entityIdParamsSchema,
    responses: { 200: { description: 'The nodes', schema: nodeListSchema } },
    errors: [401, 403, 404],
  })
  list(@CurrentEntity() entity: EntityContext) {
    return this.nodes.list(entity.entityId);
  }

  @Post()
  @EntityAccess('node.write')
  // The response carries a one-time token: it must never be cached anywhere.
  @Header('cache-control', 'no-store')
  @ApiOperation({
    operationId: 'createNode',
    summary: 'Register a node and issue its single-use enrollment token',
    description:
      'Returns the enrollment token once; it cannot be retrieved again. It is valid for ' +
      'RID_NODE_ENROLLMENT_TTL_HOURS hours (72 by default) and enrolls a single kit installation.',
    tags: ['nodes'],
    params: entityIdParamsSchema,
    body: createNodeSchema,
    responses: {
      201: { description: 'The node and its token', schema: issuedEnrollmentTokenSchema },
    },
    errors: [400, 401, 403, 404, 409],
  })
  create(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createNodeSchema)) body: CreateNodeInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.nodes.create(entity.entityId, principal, body, request.id);
  }

  @Get(':nodeId')
  @EntityAccess('node.read')
  @ApiOperation({
    operationId: 'getNode',
    summary: 'A node with its enrollment tokens (never the tokens themselves)',
    tags: ['nodes'],
    params: nodeIdParamsSchema,
    responses: { 200: { description: 'The node', schema: nodeDetailSchema } },
    errors: [401, 403, 404],
  })
  get(@CurrentEntity() entity: EntityContext, @Param('nodeId', uuid) nodeId: string) {
    return this.nodes.get(entity.entityId, nodeId);
  }

  @Post(':nodeId/enrollment-tokens')
  @EntityAccess('node.write')
  @Header('cache-control', 'no-store')
  @ApiOperation({
    operationId: 'reissueEnrollmentToken',
    summary: 'Issue a new enrollment token for a node that has not enrolled',
    description: 'Revokes the token still active, if any: a node has one usable token at a time.',
    tags: ['nodes'],
    params: nodeIdParamsSchema,
    responses: {
      201: { description: 'The node and its new token', schema: issuedEnrollmentTokenSchema },
    },
    errors: [401, 403, 404, 409],
  })
  reissue(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('nodeId', uuid) nodeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.nodes.reissue(entity.entityId, nodeId, principal, request.id);
  }

  @Post(':nodeId/enrollment-tokens/:tokenId/revoke')
  @HttpCode(200)
  @EntityAccess('node.write')
  @ApiOperation({
    operationId: 'revokeEnrollmentToken',
    summary: 'Revoke an unused enrollment token',
    tags: ['nodes'],
    params: enrollmentTokenParamsSchema,
    responses: { 200: { description: 'The node', schema: nodeDetailSchema } },
    errors: [401, 403, 404, 409],
  })
  revokeToken(
    @CurrentEntity() entity: EntityContext,
    @CurrentPrincipal() principal: Principal,
    @Param('nodeId', uuid) nodeId: string,
    @Param('tokenId', uuid) tokenId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.nodes.revokeToken(entity.entityId, nodeId, tokenId, principal, request.id);
  }
}

/** Every node of the network, for the operator console (SPEC.md §6). */
@Controller('admin/nodes')
export class AdminNodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get()
  @PlatformAccess('node.list')
  @ApiOperation({
    operationId: 'listNetworkNodes',
    summary: 'Every node of the network: state, kit version and last heartbeat',
    tags: ['nodes'],
    responses: { 200: { description: 'The nodes', schema: networkNodeListSchema } },
    errors: [401, 403],
  })
  list() {
    return this.nodes.listNetwork();
  }
}
