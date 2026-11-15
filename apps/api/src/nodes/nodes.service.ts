import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type CreateNodeInput,
  createNodeSchema,
  type EnrollmentToken,
  type IssuedEnrollmentToken,
  type NetworkNode,
  type NodeDetail,
  type NodeService,
  type NodeSummary,
  nodeServiceSchema,
} from '@rid/contracts';
import { z } from 'zod';
import { type AuditActor, AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { hashSecret } from '../common/secrets.js';
import { assertEntityActive } from '../domain/entity/active.js';
import { assertTransition } from '../domain/node/state-machine.js';
import type { NodeEnrollmentToken, Node as NodeRow } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';

/** Prefix of enrollment tokens: recognizable in a leaked log or a secret scanner. */
export const ENROLLMENT_TOKEN_PREFIX = 'rid-enroll-';

/** Hours an enrollment token stays valid (RID_NODE_ENROLLMENT_TTL_HOURS, 72 by SPEC.md §4.6). */
export function enrollmentTokenExpiry(now = new Date()): Date {
  const hours = Number(process.env.RID_NODE_ENROLLMENT_TTL_HOURS ?? 72);
  const ttl = Number.isFinite(hours) && hours > 0 && hours <= 24 * 30 ? hours : 72;
  return new Date(now.getTime() + ttl * 60 * 60 * 1000);
}

/** 256 bits of entropy; only its SHA-256 is stored. */
export const generateEnrollmentToken = (): string =>
  `${ENROLLMENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

type NodeWithTokens = NodeRow & { enrollmentTokens: NodeEnrollmentToken[] };

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export function tokenView(t: NodeEnrollmentToken, now = new Date()): EnrollmentToken {
  return {
    id: t.id,
    status: t.status === 'active' && t.expiresAt <= now ? 'expired' : t.status,
    expiresAt: t.expiresAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    usedAt: iso(t.usedAt),
    revokedAt: iso(t.revokedAt),
  };
}

/** The services a node declared, as stored (validated again: jsonb is not trusted blindly). */
export function storedServices(value: unknown): NodeService[] {
  const parsed = z.array(nodeServiceSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'failing']),
  detail: z.string().optional(),
  checkedAt: z.iso.datetime(),
});

export function storedHealth(value: unknown): NodeSummary['health'] {
  const parsed = healthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function nodeView(node: NodeWithTokens): NodeSummary {
  const latest = [...node.enrollmentTokens].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    kitVersion: node.kitVersion,
    tunnelAddress: node.tunnelAddress,
    lastHeartbeatAt: iso(node.lastHeartbeatAt),
    enrolledAt: iso(node.enrolledAt),
    certificateNotAfter: iso(node.certificateNotAfter),
    services: storedServices(node.services),
    health: storedHealth(node.health),
    createdAt: node.createdAt.toISOString(),
    enrollmentToken: latest ? tokenView(latest) : null,
  };
}

const tokensNewestFirst = { orderBy: { createdAt: 'desc' as const } };

/**
 * Nodes of the instant-APIs kit, portal side (SPEC.md §4.6, ARCHITECTURE.md §10). M4-01: an
 * entity_admin (or the operator) registers a node and gets a single-use enrollment token, valid
 * 72 hours, to install the kit with; tokens can be listed (never shown again) and revoked.
 */
@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private actor(principal: Principal, entityId: string): AuditActor {
    return { type: 'user', id: principal.keycloakSub, entityId };
  }

  async list(entityId: string): Promise<{ items: NodeSummary[] }> {
    const nodes = (await scopedRepo(this.prisma.node, entityId).findMany({
      include: { enrollmentTokens: tokensNewestFirst },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })) as NodeWithTokens[];
    return { items: nodes.map(nodeView) };
  }

  private async load(entityId: string, nodeId: string, tx?: Tx): Promise<NodeWithTokens> {
    const node = (await scopedRepo((tx ?? this.prisma).node, entityId).findFirst({
      where: { id: nodeId },
      include: { enrollmentTokens: tokensNewestFirst },
    })) as NodeWithTokens | null;
    if (!node) throw new NotFoundError('Node');
    return node;
  }

  async get(entityId: string, nodeId: string): Promise<NodeDetail> {
    const node = await this.load(entityId, nodeId);
    return { ...nodeView(node), enrollmentTokens: node.enrollmentTokens.map((t) => tokenView(t)) };
  }

  /** Every node of the network, for the operator console (SPEC.md §6). */
  async listNetwork(): Promise<{ items: NetworkNode[] }> {
    const nodes = await this.prisma.node.findMany({
      include: {
        enrollmentTokens: tokensNewestFirst,
        entity: { select: { id: true, slug: true, shortName: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 2_000,
    });
    return { items: nodes.map((n) => ({ ...nodeView(n), entity: n.entity })) };
  }

  /** Creates the token inside `tx` and audits it. The caller returns the token once. */
  private async issueInTx(
    tx: Tx,
    node: NodeRow,
    principal: Principal,
    requestId?: string,
  ): Promise<{ token: string; row: NodeEnrollmentToken }> {
    const token = generateEnrollmentToken();
    const row = await tx.nodeEnrollmentToken.create({
      data: {
        nodeId: node.id,
        tokenHash: hashSecret(token),
        expiresAt: enrollmentTokenExpiry(),
        issuedBy: principal.userId,
      },
    });
    await this.audit.record(tx, {
      actor: this.actor(principal, node.entityId),
      action: 'node.enrollment_token_issued',
      target: { type: 'node', id: node.id },
      // Never the token nor its hash.
      after: { tokenId: row.id, expiresAt: row.expiresAt.toISOString() },
      requestId,
    });
    return { token, row };
  }

  async create(
    entityId: string,
    principal: Principal,
    input: CreateNodeInput,
    requestId?: string,
  ): Promise<IssuedEnrollmentToken> {
    const { name } = createNodeSchema.parse(input);
    await assertEntityActive(this.prisma, entityId);
    try {
      const { nodeId, token, expiresAt } = await this.prisma.$transaction(async (tx) => {
        const node = await tx.node.create({
          data: { entityId, name, status: 'enrollment_issued', createdBy: principal.userId },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal, entityId),
          action: 'node.created',
          target: { type: 'node', id: node.id },
          after: { entityId, name, status: node.status },
          requestId,
        });
        const issued = await this.issueInTx(tx, node, principal, requestId);
        return { nodeId: node.id, token: issued.token, expiresAt: issued.row.expiresAt };
      });
      return {
        node: nodeView(await this.load(entityId, nodeId)),
        token,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(`The entity already has a node named "${name}"`);
      }
      throw error;
    }
  }

  /**
   * A new token for a node that has not enrolled yet (the previous one expired or was lost). Any
   * token still active is revoked first: a node has at most one usable token.
   */
  async reissue(
    entityId: string,
    nodeId: string,
    principal: Principal,
    requestId?: string,
  ): Promise<IssuedEnrollmentToken> {
    await assertEntityActive(this.prisma, entityId);
    const { token, expiresAt } = await this.prisma.$transaction(async (tx) => {
      const node = await this.load(entityId, nodeId, tx);
      if (node.status !== 'enrollment_issued') {
        throw new ConflictError(`The node is ${node.status}: it does not need a token`);
      }
      for (const old of node.enrollmentTokens.filter((t) => t.status === 'active')) {
        await this.revokeInTx(tx, node, old, principal, 'superseded', requestId);
      }
      const issued = await this.issueInTx(tx, node, principal, requestId);
      return { token: issued.token, expiresAt: issued.row.expiresAt };
    });
    return {
      node: nodeView(await this.load(entityId, nodeId)),
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async revokeInTx(
    tx: Tx,
    node: NodeRow,
    token: NodeEnrollmentToken,
    principal: Principal,
    reason: 'revoked' | 'superseded',
    requestId?: string,
  ): Promise<void> {
    const changed = await tx.nodeEnrollmentToken.updateMany({
      where: { id: token.id, nodeId: node.id, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date(), revokedBy: principal.userId },
    });
    if (changed.count === 0) throw new ConflictError('The token changed meanwhile');
    await this.audit.record(tx, {
      actor: this.actor(principal, node.entityId),
      action: 'node.enrollment_token_revoked',
      target: { type: 'node', id: node.id },
      before: { tokenId: token.id, status: 'active' },
      after: { tokenId: token.id, status: 'revoked', reason },
      requestId,
    });
  }

  /**
   * Takes a node out of the network (SPEC.md §4.6). Final: the control channel no longer accepts
   * its certificate, the hub drops its peer (M4-03) and versions on it stop being served (M4-04).
   * A token still active is revoked with it.
   */
  async decommission(
    entityId: string,
    nodeId: string,
    principal: Principal,
    reason: string | undefined,
    requestId?: string,
  ): Promise<NodeDetail> {
    await this.prisma.$transaction(async (tx) => {
      const node = await this.load(entityId, nodeId, tx);
      assertTransition(node.status, 'decommissioned');
      for (const token of node.enrollmentTokens.filter((t) => t.status === 'active')) {
        await this.revokeInTx(tx, node, token, principal, 'revoked', requestId);
      }
      const changed = await tx.node.updateMany({
        where: { id: nodeId, entityId, status: node.status },
        data: { status: 'decommissioned', decommissionedAt: new Date() },
      });
      if (changed.count === 0) throw new ConflictError('The node changed meanwhile');
      await this.audit.record(tx, {
        actor: this.actor(principal, entityId),
        action: 'node.decommissioned',
        target: { type: 'node', id: nodeId },
        before: { status: node.status },
        after: { status: 'decommissioned', ...(reason ? { reason } : {}) },
        requestId,
      });
    });
    return this.get(entityId, nodeId);
  }

  /** Revokes ("anula") a token that was not used: it no longer enrolls anything. */
  async revokeToken(
    entityId: string,
    nodeId: string,
    tokenId: string,
    principal: Principal,
    requestId?: string,
  ): Promise<NodeDetail> {
    await this.prisma.$transaction(async (tx) => {
      const node = await this.load(entityId, nodeId, tx);
      const token = node.enrollmentTokens.find((t) => t.id === tokenId);
      if (!token) throw new NotFoundError('Enrollment token');
      if (token.status !== 'active') {
        throw new ConflictError(`The token was already ${token.status}`);
      }
      await this.revokeInTx(tx, node, token, principal, 'revoked', requestId);
    });
    return this.get(entityId, nodeId);
  }
}
