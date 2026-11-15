import { Body, Controller, Get, Header, HttpCode, Post, Req } from '@nestjs/common';
import {
  type EnrollNodeInput,
  enrollNodeSchema,
  nodeConfigSchema,
  nodeControlParamsSchema,
  nodeEnrollmentSchema,
  type NodeHeartbeatInput,
  nodeHeartbeatResponseSchema,
  nodeHeartbeatSchema,
  renewedNodeCertificateSchema,
  renewNodeCertificateSchema,
} from '@rid/contracts';
import { type AuthenticatedRequest, Public } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Node as NodeRow } from '../generated/prisma/client.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { CurrentNode, NodeAccess } from './node-control.guard.js';
import { NodeControlService } from './node-control.service.js';

/**
 * Contract with the kit, v1 (ARCHITECTURE.md §10, ADR-0011). Enrollment takes the single-use
 * token; everything after it, the node's certificate through the gateway's control route.
 */
@Controller('nodes')
export class NodeControlController {
  constructor(private readonly control: NodeControlService) {}

  @Post('enroll')
  @Public()
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  @ApiOperation({
    operationId: 'enrollNode',
    summary: 'Enroll a kit node with its single-use token',
    description:
      'The kit sends its token, a CSR (CN=rid-node, no other names) and its WireGuard public ' +
      'key. It receives its certificate (DNS name rid-node-<nodeId>), the network root, its ' +
      'tunnel configuration and where the control channel is. The token stops working.',
    tags: ['node contract'],
    body: enrollNodeSchema,
    responses: { 201: { description: 'The node is enrolled', schema: nodeEnrollmentSchema } },
    errors: [400, 401, 409, 503],
    authenticated: false,
  })
  enroll(
    @Body(new ZodValidationPipe(enrollNodeSchema)) body: EnrollNodeInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.control.enroll(body, request.id);
  }

  @Post(':nodeId/heartbeat')
  @NodeAccess()
  @HttpCode(200)
  @ApiOperation({
    operationId: 'nodeHeartbeat',
    summary: 'Heartbeat of a node: version, services it exposes and health',
    description:
      'Every heartbeatIntervalSeconds. Five minutes without one and the node goes offline.',
    tags: ['node contract'],
    params: nodeControlParamsSchema,
    body: nodeHeartbeatSchema,
    responses: { 200: { description: 'Accepted', schema: nodeHeartbeatResponseSchema } },
    errors: [400, 401, 409],
    authenticated: 'node',
  })
  heartbeat(
    @CurrentNode() node: NodeRow,
    @Body(new ZodValidationPipe(nodeHeartbeatSchema)) body: NodeHeartbeatInput,
  ) {
    return this.control.heartbeat(node, body);
  }

  @Post(':nodeId/renew')
  @NodeAccess()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @ApiOperation({
    operationId: 'renewNodeCertificate',
    summary: 'Renew the certificate of a node for a new key',
    tags: ['node contract'],
    params: nodeControlParamsSchema,
    body: renewNodeCertificateSchema,
    responses: {
      200: { description: 'The new certificate', schema: renewedNodeCertificateSchema },
    },
    errors: [400, 401, 409, 503],
    authenticated: 'node',
  })
  renew(
    @CurrentNode() node: NodeRow,
    @Body(new ZodValidationPipe(renewNodeCertificateSchema)) body: { csr: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.control.renew(node, body.csr, request.id);
  }

  @Get(':nodeId/config')
  @NodeAccess()
  @ApiOperation({
    operationId: 'getNodeConfig',
    summary: 'What the network expects from the node',
    tags: ['node contract'],
    params: nodeControlParamsSchema,
    responses: { 200: { description: 'The configuration', schema: nodeConfigSchema } },
    errors: [401],
    authenticated: 'node',
  })
  config(@CurrentNode() node: NodeRow) {
    return this.control.config(node);
  }
}
