import { NOTIFICATION_TOPIC, NOTIFYING_ACTIONS } from '../notifications/notifying-actions.js';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../prisma/prisma.service.js';
import { requestIp } from '../common/request-context.js';
import { eventHash } from './chain.js';
import { sanitizeForAudit } from './sanitize.js';

export type ActorType = 'user' | 'system' | 'application';

export interface AuditActor {
  type: ActorType;
  id: string;
  entityId?: string;
}

export interface AuditInput {
  actor: AuditActor;
  /** Dotted, lower snake_case: `<context>.<event>`, e.g. `subscription.approved`. */
  action: string;
  target: { type: string; id: string };
  before?: unknown;
  after?: unknown;
  /** The caller's address; by default the one of the request being handled (M-27). */
  ip?: string;
  requestId?: string;
}

const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/**
 * The JSON as it will read back from jsonb: sanitized, then through JSON once more (NaN becomes
 * null, and so on), so the hash computed now matches the one recomputed when verifying.
 */
const toJson = (value: unknown): Prisma.InputJsonValue | null => {
  const clean = value === undefined ? undefined : sanitizeForAudit(value);
  return clean === undefined ? null : (JSON.parse(JSON.stringify(clean)) as Prisma.InputJsonValue);
};

/** Key of the transaction-level advisory lock that serializes appends to the chain. */
const CHAIN_LOCK = 0x7269645f61756469n; // "den_audi"

/**
 * Records domain state changes (CLAUDE.md, rule 4). It takes the transaction client on purpose:
 * the event is written in the same transaction as the change it describes, so both commit or
 * neither does.
 *
 * Hash chain (ARCHITECTURE.md §7, M1-11): under a transaction-level advisory lock, each event
 * takes seq = last seq + 1 (no gaps, unlike a sequence when a transaction rolls back) and
 * hash = SHA-256(prev_hash ‖ canonical JSON). The lock is held until the transaction ends, so
 * appends are serialized in commit order.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, input: AuditInput): Promise<bigint> {
    if (!ACTION.test(input.action)) {
      throw new Error(`Invalid audit action "${input.action}" (expected <context>.<event>)`);
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`;
    const last = await tx.auditEvent.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true, hash: true },
    });
    const fields = {
      seq: (last?.seq ?? 0n) + 1n,
      occurredAt: new Date(),
      actorType: input.actor.type,
      actorId: input.actor.id,
      actorEntityId: input.actor.entityId ?? null,
      action: input.action,
      targetType: input.target.type,
      targetId: input.target.id,
      before: toJson(input.before),
      after: toJson(input.after),
      // A person's or an application's request: its address. The system's events (background
      // jobs) have none, even when a request set them going.
      ip: input.ip ?? (input.actor.type === 'system' ? undefined : requestIp()) ?? null,
      requestId: input.requestId ?? null,
    };
    // Events before the chain existed have no hash: the first hashed event is the genesis.
    const prevHash = last?.hash ?? null;
    const event = await tx.auditEvent.create({
      data: {
        ...fields,
        before: fields.before ?? Prisma.DbNull,
        after: fields.after ?? Prisma.DbNull,
        prevHash,
        hash: eventHash(prevHash, fields),
      },
      select: { seq: true },
    });
    // Notifications (M2-08) are derived from the event, queued in this same transaction.
    if (NOTIFYING_ACTIONS.has(input.action)) {
      await tx.outboxMessage.create({
        data: {
          topic: NOTIFICATION_TOPIC,
          aggregate: `audit:${event.seq}`,
          payload: { seq: event.seq.toString() },
        },
      });
    }
    return event.seq;
  }
}
