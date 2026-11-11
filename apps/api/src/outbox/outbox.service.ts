import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../prisma/prisma.service.js';

export interface OutboxInput {
  /** Queue that will receive the job, e.g. `gateway.sync`. */
  topic: string;
  /** What to reconcile, e.g. `apiVersion:<uuid>`. Jobs with the same aggregate are coalesced. */
  aggregate: string;
  payload?: Prisma.InputJsonObject;
}

const TOPIC = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Transactional outbox (ADR-0007): call it inside the domain transaction, so the sync work is
 * recorded if and only if the state change commits. Never call APISIX/Keycloak from handlers.
 */
@Injectable()
export class OutboxService {
  async enqueue(tx: Tx, input: OutboxInput): Promise<string> {
    if (!TOPIC.test(input.topic)) {
      throw new Error(`Invalid outbox topic "${input.topic}" (expected <area>.<action>)`);
    }
    if (!input.aggregate) throw new Error('Outbox message needs an aggregate');
    const message = await tx.outboxMessage.create({
      data: { topic: input.topic, aggregate: input.aggregate, payload: input.payload ?? {} },
      select: { id: true },
    });
    return message.id;
  }
}
