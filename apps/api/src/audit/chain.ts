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
 * hash = SHA-256(prevHash ‖ canonical JSON of the event) (ARCHITECTURE.md §7). The first event of
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
    reason: 'gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'missing_hash';
  };
}

/**
 * Incremental verifier: feed events in seq order (in batches) and read the result at the end.
 * Detects a modified event (hash), a removed or reordered one (prev_hash or gap in seq) and an
 * event inserted without going through the chain (missing hash after the chain started).
 */
export class ChainVerifier {
  private previous: { seq: bigint; hash: string } | undefined;
  private result: ChainCheck = {
    valid: true,
    verified: 0,
    unchained: 0,
    firstSeq: null,
    lastSeq: null,
    lastHash: null,
  };

  get done(): boolean {
    return !this.result.valid;
  }

  push(event: ChainedEvent): void {
    if (!this.result.valid) return;
    const fail = (reason: NonNullable<ChainCheck['brokenAt']>['reason']) => {
      this.result.valid = false;
      this.result.brokenAt = { seq: event.seq.toString(), reason };
    };
    if (!this.previous) {
      // Before the chain starts, events have no hash at all.
      if (!event.hash) {
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
    this.previous = { seq: event.seq, hash: event.hash };
    this.result.verified += 1;
    this.result.lastSeq = event.seq.toString();
    this.result.lastHash = event.hash;
  }

  check(): ChainCheck {
    return { ...this.result };
  }
}
