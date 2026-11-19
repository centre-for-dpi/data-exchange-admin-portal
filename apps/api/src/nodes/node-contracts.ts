import type { NodeService, NodeVersionContract } from '@den/contracts';
import { z } from 'zod';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { compareContract } from '../domain/node/contract.js';
import type { NodeContractCheck, Prisma } from '../generated/prisma/client.js';
import type { PrismaService, Tx } from '../prisma/prisma.service.js';
import { storedServices } from './node-status.js';

/** Versions the gateway serves (ADR-0019: deprecated ones until they are retired). */
export const SERVED_STATUSES = ['published', 'deprecated'] as const;

/** Audited on every change of a version's contract status; matches → differs notifies. */
export const NODE_CONTRACT_ACTION = 'api_version.node_contract_changed';

const nodeUpstreamSchema = z.object({
  type: z.literal('node'),
  nodeId: z.string(),
  servicePath: z.string(),
});

/** The node and service path of a `node` upstream that names a node; undefined otherwise. */
export function nodeUpstreamOf(
  upstream: unknown,
): { nodeId: string; servicePath: string } | undefined {
  const parsed = nodeUpstreamSchema.safeParse(upstream);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Served versions with a `node` upstream; on one node when given (a JSON path filter). Lists of
 * nodes are filtered in memory: served versions on nodes are few.
 */
const servedOn = (nodeId?: string): Prisma.ApiVersionWhereInput => ({
  upstreamType: 'node',
  status: { in: [...SERVED_STATUSES] },
  ...(nodeId ? { upstream: { path: ['nodeId'], equals: nodeId } } : {}),
});

const VERSION_SELECT = {
  id: true,
  apiId: true,
  version: true,
  upstream: true,
  openapiSha256: true,
  openapiSha256Variants: true,
  nodeContract: true,
  api: { select: { name: true, entityId: true, entity: { select: { legalName: true } } } },
} as const satisfies Prisma.ApiVersionSelect;
type ServedVersion = Prisma.ApiVersionGetPayload<{ select: typeof VERSION_SELECT }>;

/** The stored check still describes this status on this node: its `since` holds. */
const sinceOf = (
  stored: NodeContractCheck | null,
  nodeId: string,
  status: NodeVersionContract['status'],
): string | null =>
  stored && stored.nodeId === nodeId && stored.status === status
    ? stored.since.toISOString()
    : null;

export interface NodeVersionContractRow extends NodeVersionContract {
  nodeId: string;
  nodeName: string;
  entityName: string;
}

/**
 * The contract check of served versions on kit nodes (P-02), computed now from what each node
 * reported in its last heartbeat, with `since` from the state recorded at heartbeats. Filtered by
 * node ids or version ids; only nodes of the version's own entity count.
 */
export async function nodeContracts(
  prisma: PrismaService | Tx,
  filter: { nodeIds?: string[]; versionIds?: string[] },
): Promise<NodeVersionContractRow[]> {
  if (filter.nodeIds?.length === 0 || filter.versionIds?.length === 0) return [];
  const versions = await prisma.apiVersion.findMany({
    where: {
      ...servedOn(filter.nodeIds?.length === 1 ? filter.nodeIds[0] : undefined),
      ...(filter.versionIds ? { id: { in: filter.versionIds } } : {}),
    },
    select: VERSION_SELECT,
    orderBy: { id: 'asc' },
  });
  const wanted = filter.nodeIds ? new Set(filter.nodeIds) : null;
  const upstreams = new Map(
    versions.flatMap((v) => {
      const u = nodeUpstreamOf(v.upstream);
      return u && (!wanted || wanted.has(u.nodeId)) ? [[v.id, u] as const] : [];
    }),
  );
  const nodes = await prisma.node.findMany({
    where: { id: { in: [...new Set([...upstreams.values()].map((u) => u.nodeId))] } },
    select: { id: true, entityId: true, name: true, services: true },
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return versions.flatMap((v) => {
    const upstream = upstreams.get(v.id);
    const node = upstream ? byId.get(upstream.nodeId) : undefined;
    if (!upstream || !node || node.entityId !== v.api.entityId) return [];
    return [view(v, upstream.servicePath, node, storedServices(node.services))];
  });
}

function view(
  v: ServedVersion,
  servicePath: string,
  node: { id: string; name: string },
  services: NodeService[],
): NodeVersionContractRow {
  const compared = compareContract(v, services, servicePath);
  return {
    apiVersionId: v.id,
    apiId: v.apiId,
    apiName: v.api.name,
    version: v.version,
    servicePath,
    status: compared.status,
    serviceName: compared.serviceName,
    expectedSha256: v.openapiSha256,
    reportedSha256: compared.reportedSha256,
    since: sinceOf(v.nodeContract, node.id, compared.status),
    nodeId: node.id,
    nodeName: node.name,
    entityName: v.api.entity.legalName,
  };
}

/**
 * At each heartbeat (P-02): compares what the node reports with every served version on it and
 * records what changed, in the heartbeat's transaction. Nothing is written when nothing changed,
 * so `since` is when the current status began. Every status change is audited
 * (`api_version.node_contract_changed`); the one from `matches` to `differs` notifies the
 * entity's publishers and admins. A concurrent heartbeat that already recorded the change makes
 * the conditional write miss, and nothing is audited twice. It never touches the routes.
 */
export async function recordNodeContracts(
  tx: Tx,
  audit: AuditService,
  actor: AuditActor,
  node: { id: string; entityId: string },
  services: NodeService[],
  now: Date,
): Promise<void> {
  const versions = await tx.apiVersion.findMany({
    where: { ...servedOn(node.id), api: { entityId: node.entityId } },
    select: VERSION_SELECT,
    orderBy: { id: 'asc' },
  });
  for (const v of versions) {
    const upstream = nodeUpstreamOf(v.upstream);
    if (upstream?.nodeId !== node.id) continue;
    const current = view(v, upstream.servicePath, { id: node.id, name: '' }, services);
    const stored = v.nodeContract?.nodeId === node.id ? v.nodeContract : null;
    if (
      stored &&
      stored.status === current.status &&
      stored.serviceName === current.serviceName &&
      stored.expectedSha256 === current.expectedSha256 &&
      stored.reportedSha256 === current.reportedSha256
    ) {
      continue;
    }
    const statusChanged = stored?.status !== current.status;
    const data = {
      nodeId: node.id,
      status: current.status,
      serviceName: current.serviceName,
      expectedSha256: current.expectedSha256,
      reportedSha256: current.reportedSha256,
      since: statusChanged ? now : (stored?.since ?? now),
    };
    const written = v.nodeContract
      ? await tx.nodeContractCheck.updateMany({
          where: {
            apiVersionId: v.id,
            nodeId: v.nodeContract.nodeId,
            status: v.nodeContract.status,
            updatedAt: v.nodeContract.updatedAt,
          },
          data,
        })
      : await tx.nodeContractCheck.createMany({
          data: [{ apiVersionId: v.id, ...data }],
          skipDuplicates: true,
        });
    if (written.count === 0 || !statusChanged) continue;
    await audit.record(tx, {
      actor,
      action: NODE_CONTRACT_ACTION,
      target: { type: 'api_version', id: v.id },
      before: stored ? { status: stored.status, reportedSha256: stored.reportedSha256 } : null,
      after: {
        status: current.status,
        nodeId: node.id,
        servicePath: upstream.servicePath,
        serviceName: current.serviceName,
        expectedSha256: current.expectedSha256,
        reportedSha256: current.reportedSha256,
      },
    });
  }
}
