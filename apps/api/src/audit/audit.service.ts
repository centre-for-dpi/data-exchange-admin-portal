import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../prisma/prisma.service.js';
import { requestIp } from '../common/request-context.js';
import { appendEvents, deferEvent, type PendingEvent } from './audit-buffer.js';
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

/**
 * Records domain state changes (CLAUDE.md, rule 4). It takes the transaction client on purpose:
 * the event is written in the same transaction as the change it describes, so both commit or
 * neither does.
 *
 * Hash chain (ARCHITECTURE.md §7, M1-11): see `appendEvents`. In a transaction opened by
 * `PrismaService.$transaction` the event is kept and appended when the callback returns, just
 * before the commit, so the chain lock is held briefly however long the transaction is (B-04).
 * Callers must therefore not read the event back inside the transaction.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, input: AuditInput): Promise<void> {
    if (!ACTION.test(input.action)) {
      throw new Error(`Invalid audit action "${input.action}" (expected <context>.<event>)`);
    }
    // Snapshots are taken now: the caller may change the objects before the event is appended.
    const event: PendingEvent = {
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
    if (!deferEvent(tx, event)) await appendEvents(tx, [event]);
  }
}
