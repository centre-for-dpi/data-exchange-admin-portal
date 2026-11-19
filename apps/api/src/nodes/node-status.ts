import { type NodeService, nodeServiceSchema, type UpstreamNode } from '@den/contracts';
import { z } from 'zod';
import type { PrismaService } from '../prisma/prisma.service.js';

/** The node a version's upstream names, if any (upstream JSON: { type: 'node', nodeId }). */
export const nodeIdOf = (upstream: unknown): string | undefined => {
  const u = upstream as { type?: unknown; nodeId?: unknown } | null;
  return u?.type === 'node' && typeof u.nodeId === 'string' ? u.nodeId : undefined;
};

/** The services a node declared, as stored (validated again: jsonb is not trusted blindly). */
export function storedServices(value: unknown): NodeService[] {
  const parsed = z.array(nodeServiceSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * State of the kit nodes behind some API versions (SPEC.md §4.6 step 5, M4-04), by node id. Only
 * nodes of the version's own entity count: a version naming another entity's node shows nothing
 * of that node (the gateway never calls it either).
 */
export async function upstreamNodes(
  prisma: PrismaService,
  versions: ReadonlyArray<{ upstream: unknown; entityId: string }>,
): Promise<Map<string, UpstreamNode>> {
  const wanted = versions.flatMap((v) => {
    const id = nodeIdOf(v.upstream);
    return id ? [{ id, entityId: v.entityId }] : [];
  });
  if (wanted.length === 0) return new Map();
  const rows = await prisma.node.findMany({
    where: { id: { in: [...new Set(wanted.map((w) => w.id))] } },
    select: { id: true, entityId: true, name: true, status: true, lastHeartbeatAt: true },
  });
  return new Map(
    rows
      .filter((r) => wanted.some((w) => w.id === r.id && w.entityId === r.entityId))
      .map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          status: r.status,
          lastHeartbeatAt: r.lastHeartbeatAt?.toISOString() ?? null,
        },
      ]),
  );
}
