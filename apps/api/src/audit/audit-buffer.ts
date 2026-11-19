import { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../prisma/prisma.service.js';
import { NOTIFICATION_TOPIC, NOTIFYING_ACTIONS } from '../notifications/notifying-actions.js';
import { eventHash } from './chain.js';

/** An event as recorded by the caller; seq, time and hashes are given when it is appended. */
export interface PendingEvent {
  actorType: 'user' | 'system' | 'application';
  actorId: string;
  actorEntityId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before: Prisma.InputJsonValue | null;
  after: Prisma.InputJsonValue | null;
  ip: string | null;
  requestId: string | null;
}

/** Key of the transaction-level advisory lock that serializes appends to the chain. */
const CHAIN_LOCK = 0x7269645f61756469n; // "den_audi"

/**
 * Events recorded inside a transaction that `PrismaService.$transaction` opened, waiting for its
 * end (B-04). The chain lock is held until the transaction commits, so taking it when the event is
 * recorded would hold it for the whole of a long transaction (offboarding an entity, revoking
 * hundreds of certificates) and every other writer in the network would queue behind it until
 * its own transaction timed out. Events recorded in a transaction this wrapper did not open are
 * written at once, as before.
 */
const buffers = new WeakMap<object, PendingEvent[]>();

/** Runs `body` in a transaction whose audit events are appended just before it commits. */
export async function withAuditBuffer<T>(body: (tx: Tx) => Promise<T>, tx: Tx): Promise<T> {
  buffers.set(tx, []);
  try {
    const result = await body(tx);
    const events = buffers.get(tx) ?? [];
    if (events.length > 0) await appendEvents(tx, events);
    return result;
  } finally {
    buffers.delete(tx);
  }
}

/** Queues the event when `tx` is a buffered transaction; false when it must be written now. */
export function deferEvent(tx: Tx, event: PendingEvent): boolean {
  const buffer = buffers.get(tx);
  if (!buffer) return false;
  buffer.push(event);
  return true;
}

/**
 * Appends events to the chain (ARCHITECTURE.md §7, M1-11): under the chain's advisory lock, each
 * takes seq = last seq + 1 (no gaps, unlike a sequence when a transaction rolls back) and
 * hash = SHA-256(prev_hash ‖ canonical JSON). All events of one call share one timestamp, taken
 * after the lock, so the chain's time never goes back. Notifications (M2-08) derive from the
 * events and are queued in the same transaction.
 */
export async function appendEvents(tx: Tx, events: PendingEvent[]): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`;
  const last = await tx.auditEvent.findFirst({
    orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });
  const occurredAt = new Date();
  let seq = last?.seq ?? 0n;
  // Events before the chain existed have no hash: the first hashed event is the genesis.
  let prevHash = last?.hash ?? null;
  const rows: Prisma.AuditEventCreateManyInput[] = [];
  const notify: Prisma.OutboxMessageCreateManyInput[] = [];
  for (const event of events) {
    seq += 1n;
    const fields = { seq, occurredAt, ...event };
    const hash = eventHash(prevHash, fields);
    rows.push({
      ...fields,
      before: fields.before ?? Prisma.DbNull,
      after: fields.after ?? Prisma.DbNull,
      prevHash,
      hash,
    });
    prevHash = hash;
    if (NOTIFYING_ACTIONS.has(event.action)) {
      notify.push({
        topic: NOTIFICATION_TOPIC,
        aggregate: `audit:${seq}`,
        payload: { seq: seq.toString() },
      });
    }
  }
  await tx.auditEvent.createMany({ data: rows });
  if (notify.length > 0) await tx.outboxMessage.createMany({ data: notify });
}
