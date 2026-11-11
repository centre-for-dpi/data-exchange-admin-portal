import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../prisma/prisma.service.js';
import { sanitizeForAudit } from './sanitize.js';

export type ActorType = 'user' | 'system' | 'application';

export interface AuditInput {
  actor: { type: ActorType; id: string; entityId?: string };
  /** Dotted, lower snake_case: `<context>.<event>`, e.g. `subscription.approved`. */
  action: string;
  target: { type: string; id: string };
  before?: unknown;
  after?: unknown;
  ip?: string;
  requestId?: string;
}

const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined ? undefined : (sanitizeForAudit(value) as Prisma.InputJsonValue);

/**
 * Records domain state changes (CLAUDE.md, rule 4). It takes the transaction client on purpose:
 * the event is written in the same transaction as the change it describes, so both commit or
 * neither does. The hash chain (prev_hash/hash) is added in M1-11.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, input: AuditInput): Promise<bigint> {
    if (!ACTION.test(input.action)) {
      throw new Error(`Invalid audit action "${input.action}" (expected <context>.<event>)`);
    }
    const event = await tx.auditEvent.create({
      data: {
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorEntityId: input.actor.entityId ?? null,
        action: input.action,
        targetType: input.target.type,
        targetId: input.target.id,
        before: toJson(input.before),
        after: toJson(input.after),
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      },
      select: { seq: true },
    });
    return event.seq;
  }
}
