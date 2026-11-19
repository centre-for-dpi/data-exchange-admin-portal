import { createHash } from 'node:crypto';
import { canonicalJson } from '../common/canonical-json.js';

/** The fields of an audit event that the chain protects (everything but prev_hash and hash). */
export interface ChainedFields {
  seq: bigint;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  actorEntityId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
}

export interface ChainedEvent extends ChainedFields {
  prevHash: string | null;
  hash: string | null;
}

/**
 * hash = SHA-256(prevHash โ€– canonical JSON of the event) (ARCHITECTURE.md ยง7). The first event of
 * the chain uses an empty prevHash. JSON values are compared in their canonical form, so the
 * hash survives the round trip through jsonb.
 */
export function eventHash(prevHash: string | null, event: ChainedFields): string {
  const canonical = canonicalJson({
    seq: event.seq.toString(),
    occurredAt: event.occurredAt.toISOString(),
    actorType: event.actorType,
    actorId: event.actorId,
    actorEntityId: event.actorEntityId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    before: event.before ?? null,
    after: event.after ?? null,
    ip: event.ip,
    requestId: event.requestId,
  });
  return createHash('sha256')
    .update(prevHash ?? '')
    .update('\n')
    .update(canonical)
    .digest('hex');
}

/**
 * How far an event's time may differ from its neighbour's and from the verifier's clock. Events
 * are stamped by the API after it takes the chain lock, so on one clock the chain's time never
 * goes back; with several API instances their clocks (NTP, normally well under a second) and the
 * database's differ a little. A minute covers that without leaving room to backdate an event
 * across the daily anchor (ARCHITECTURE.md ง7). The audit_event trigger uses the same figure.
 */
export const CHAIN_CLOCK_SKEW_MS = 60_000;

export interface ChainCheck {
  valid: boolean;
  /** Events covered by the chain and verified. */
  verified: number;
  /**
   * Events written before the chain existed (M1-11). They precede the first hashed event and
   * cannot be verified; a fresh deployment has none.
   */
  unchained: number;
  firstSeq: string | null;
  lastSeq: string | null;
  lastHash: string | null;
  /** First event where verification failed, and why. */
  brokenAt?: {
    seq: string;
    reason:
      | 'gap'
      | 'prev_hash_mismatch'
      | 'hash_mismatch'
      | 'missing_hash'
      | 'invalid_seq'
      | 'time_regression'
      | 'future_dated';
  };
}

/**
 * Incremental verifier: feed events in seq order (in batches) and read the result at the end.
 * Detects a modified event (hash), a removed or reordered one (prev_hash or gap in seq) and an
 * event inserted without going through the chain (missing hash after the chain started, or a
 * position at or below zero), and an event whose time goes back along seq or is in the future
 * (B-01). It does not prove who wrote the chain: see ARCHITECTURE.md ง7.
 */
export class ChainVerifier {
  private previous: { seq: bigint; hash: string; occurredAt: Date } | undefined;
  private lastUnchained: bigint | undefined;
  private result: ChainCheck = {
    valid: true,
    verified: 0,
    unchained: 0,
    firstSeq: null,
    lastSeq: null,
    lastHash: null,
  };

  constructor(private readonly now: () => Date = () => new Date()) {}

  get done(): boolean {
    return !this.result.valid;
  }

  push(event: ChainedEvent): void {
    if (!this.result.valid) return;
    const fail = (reason: NonNullable<ChainCheck['brokenAt']>['reason']) => {
      this.result.valid = false;
      this.result.brokenAt = { seq: event.seq.toString(), reason };
    };
    // seq is a serial starting at 1: a row at or below zero was inserted by hand, below the
    // genesis, where a hashless event would otherwise pass as "written before the chain".
    if (event.seq <= 0n) return fail('invalid_seq');
    if (!this.previous) {
      // Before the chain starts, events have no hash at all.
      if (!event.hash) {
        if (this.lastUnchained !== undefined && event.seq <= this.lastUnchained) {
          return fail('invalid_seq');
        }
        this.lastUnchained = event.seq;
        this.result.unchained += 1;
        return;
      }
      if (event.prevHash !== null) {
        // The first chained event must be the genesis; anything else means its predecessor went.
        return fail('prev_hash_mismatch');
      }
      this.result.firstSeq = event.seq.toString();
    } else {
      if (!event.hash) return fail('missing_hash');
      if (event.seq !== this.previous.seq + 1n) return fail('gap');
      if (event.prevHash !== this.previous.hash) return fail('prev_hash_mismatch');
    }
    if (eventHash(event.prevHash, event) !== event.hash) return fail('hash_mismatch');
    const time = event.occurredAt.getTime();
    if (this.previous && time < this.previous.occurredAt.getTime() - CHAIN_CLOCK_SKEW_MS) {
      return fail('time_regression');
    }
    if (time > this.now().getTime() + CHAIN_CLOCK_SKEW_MS) return fail('future_dated');
    this.previous = { seq: event.seq, hash: event.hash, occurredAt: event.occurredAt };
    this.result.verified += 1;
    this.result.lastSeq = event.seq.toString();
    this.result.lastHash = event.hash;
  }

  check(): ChainCheck {
    return { ...this.result };
  }
}
