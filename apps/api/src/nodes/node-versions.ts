import type { OutboxService } from '../outbox/outbox.service.js';
import type { Tx } from '../prisma/prisma.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';

/** Versions the gateway serves (ADR-0019: deprecated ones until they are retired). */
const SERVED = ['published', 'deprecated'] as const;

/**
 * The served API versions whose upstream names this kit node (M4-04). They are reconciled again
 * when the node enrolls (it becomes callable) or is decommissioned (its routes go: fail closed).
 */
export async function queueGatewaySyncForNode(
  tx: Tx,
  outbox: OutboxService,
  nodeId: string,
  reason: string,
): Promise<void> {
  const versions = await tx.apiVersion.findMany({
    where: {
      upstreamType: 'node',
      status: { in: [...SERVED] },
      upstream: { path: ['nodeId'], equals: nodeId },
    },
    select: { id: true },
  });
  for (const v of versions) {
    await outbox.enqueue(tx, {
      topic: GATEWAY_SYNC_TOPIC,
      aggregate: `apiVersion:${v.id}`,
      payload: { reason },
    });
  }
}
