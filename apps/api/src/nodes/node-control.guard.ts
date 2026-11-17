import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { NODE, Public } from '../auth/decorators.js';
import { UnauthenticatedError } from '../common/errors.js';
import {
  type AuthenticatedNode,
  NodeControlService,
  nodeControlSettings,
  sameSecret,
} from './node-control.service.js';

/** Set by the gateway's control route; a client never chooses either value (M4-02). */
export const NODE_CONTROL_TOKEN_HEADER = 'x-den-node-control';
export const CLIENT_CERT_HEADER = 'x-den-client-cert-s256';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NodeRequest {
  node?: AuthenticatedNode;
}

/**
 * Authenticates kit nodes on the control channel (ARCHITECTURE.md §10). The TLS with the node's
 * certificate ends at the gateway, whose control route replaces whatever the client sent with
 * the thumbprint of the certificate verified in the handshake (den-client-cert) and adds the
 * shared control token. Without that token the request did not come through the gateway, so the
 * thumbprint header means nothing: 401. With it, the thumbprint must be the node's.
 */
@Injectable()
export class NodeControlGuard implements CanActivate {
  private readonly logger = new Logger(NodeControlGuard.name);

  constructor(private readonly control: NodeControlService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & NodeRequest & { params: Record<string, string> }>();
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const settings = nodeControlSettings();
    if (!settings.controlToken) {
      this.logger.error('DEN_NODE_CONTROL_TOKEN is not set: the control channel is closed');
      throw new UnauthenticatedError();
    }
    if (!sameSecret(header(NODE_CONTROL_TOKEN_HEADER), settings.controlToken)) {
      throw new UnauthenticatedError();
    }
    const fingerprint = header(CLIENT_CERT_HEADER);
    const nodeId = request.params.nodeId ?? '';
    if (!fingerprint || !UUID.test(nodeId)) throw new UnauthenticatedError();
    const node = await this.control.authenticate(nodeId, fingerprint);
    if (!node) throw new UnauthenticatedError('The certificate does not open this node');
    // A replaced certificate only repeats a renewal (see NodeControlService.renew).
    if (node.credential === 'previous' && !request.url.split('?')[0]?.endsWith('/renew')) {
      throw new UnauthenticatedError('The certificate was replaced: use the current one');
    }
    request.node = node;
    return true;
  }
}

/** Endpoint of the node control channel: skips the portal's guard, requires the node's mTLS. */
export const NodeAccess = () =>
  applyDecorators(Public(), SetMetadata(NODE, true), UseGuards(NodeControlGuard));

export const CurrentNode = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const node = ctx.switchToHttp().getRequest<NodeRequest>().node;
  if (!node) throw new Error('CurrentNode used without @NodeAccess');
  return node;
});
