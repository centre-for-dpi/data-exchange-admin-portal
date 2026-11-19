import { describe, expect, it } from 'vitest';
import {
  CHAIN_CLOCK_SKEW_MS,
  type ChainedEvent,
  type ChainedFields,
  ChainVerifier,
  eventHash,
} from './chain.js';

/** A valid chain of `n` events starting at `from`, after `legacy` events without hash. */
function chain(n: number, legacy = 0): ChainedEvent[] {
  const events: ChainedEvent[] = [];
  for (let i = 0; i < legacy; i += 1) {
    events.push({ ...fields(BigInt(i + 1)), prevHash: null, hash: null });
  }
  let prev: string | null = null;
  for (let i = 0; i < n; i += 1) {
    const f = fields(BigInt(legacy + i + 1));
    const hash = eventHash(prev, f);
    events.push({ ...f, prevHash: prev, hash });
    prev = hash;
  }
  return events;
}

function fields(seq: bigint): ChainedFields {
  return {
    seq,
    occurredAt: new Date(Date.UTC(2026, 10, 12, 10, 0, Number(seq))),
    actorType: 'user',
    actorId: 'sub-lucia',
    actorEntityId: 'entity-salud',
    action: 'subscription.approved',
    targetType: 'subscription',
    targetId: `sub-${seq}`,
    before: { status: 'pending_provider' },
    after: { status: 'approved', approvedOperations: ['getAfiliado'], months: 6 },
    ip: null,
    requestId: `req-${seq}`,
  };
}

const verify = (events: ChainedEvent[]) => {
  const verifier = new ChainVerifier();
  for (const e of events) verifier.push(e);
  return verifier.check();
};

describe('audit hash chain (ARCHITECTURE.md §7)', () => {
  it('verifies an intact chain and reports its head', () => {
    const events = chain(5);
    expect(verify(events)).toEqual({
      valid: true,
      verified: 5,
      unchained: 0,
      firstSeq: '1',
      lastSeq: '5',
      lastHash: events[4]?.hash,
    });
  });

  it('is independent of the key order JSON comes back with (jsonb)', () => {
    const [first] = chain(1);
    const reordered = {
      ...first!,
      after: { months: 6, approvedOperations: ['getAfiliado'], status: 'approved' },
    };
    expect(verify([reordered]).valid).toBe(true);
  });

  it('counts events written before the chain existed and verifies from the first hash', () => {
    expect(verify(chain(3, 2))).toMatchObject({
      valid: true,
      verified: 3,
      unchained: 2,
      firstSeq: '3',
    });
  });

  it('detects a modified event', () => {
    const events = chain(4);
    events[2] = { ...events[2]!, after: { status: 'active' } };
    expect(verify(events).brokenAt).toEqual({ seq: '3', reason: 'hash_mismatch' });
  });

  it('detects a modified event whose hash was recomputed (the next link breaks)', () => {
    const events = chain(4);
    const forged = { ...events[1]!, actorId: 'sub-intruso' };
    events[1] = { ...forged, hash: eventHash(forged.prevHash, forged) };
    expect(verify(events).brokenAt).toEqual({ seq: '3', reason: 'prev_hash_mismatch' });
  });

  it('detects a removed event', () => {
    const events = chain(4);
    events.splice(1, 1);
    expect(verify(events).brokenAt).toEqual({ seq: '3', reason: 'gap' });
  });

  it('detects a removed genesis', () => {
    expect(verify(chain(3).slice(1)).brokenAt).toEqual({ seq: '2', reason: 'prev_hash_mismatch' });
  });

  it('detects an event inserted without going through the chain', () => {
    const events = chain(3);
    events.push({ ...fields(4n), prevHash: null, hash: null });
    expect(verify(events).brokenAt).toEqual({ seq: '4', reason: 'missing_hash' });
  });

  // B-01
  it('rejects a hashless event below the genesis (seq 0) instead of calling it legacy', () => {
    const forged: ChainedEvent = {
      ...fields(0n),
      occurredAt: new Date(Date.UTC(2026, 0, 1)),
      prevHash: null,
      hash: null,
    };
    expect(verify([forged, ...chain(3)]).brokenAt).toEqual({ seq: '0', reason: 'invalid_seq' });
    expect(verify([{ ...forged, seq: -5n }, ...chain(3)]).valid).toBe(false);
  });

  it('requires the events before the chain to ascend', () => {
    const [a, b] = chain(2, 2);
    expect(verify([b!, a!]).brokenAt).toEqual({ seq: '1', reason: 'invalid_seq' });
  });

  it('reports an event appended with a backdated occurredAt', () => {
    const events = chain(3);
    const last = events.at(-1)!;
    const backdated = { ...fields(4n), occurredAt: new Date(Date.UTC(2025, 0, 1)) };
    events.push({ ...backdated, prevHash: last.hash, hash: eventHash(last.hash, backdated) });
    expect(verify(events).brokenAt).toEqual({ seq: '4', reason: 'time_regression' });
  });

  it('tolerates the clock skew between instances, and no more', () => {
    const at = (seq: bigint, offsetMs: number): ChainedEvent => {
      const f = {
        ...fields(seq),
        occurredAt: new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + offsetMs),
      };
      return { ...f, prevHash: null, hash: null };
    };
    const link = (events: ChainedEvent[]) => {
      let prev: string | null = null;
      return events.map((e) => {
        const hash = eventHash(prev, e);
        const linked = { ...e, prevHash: prev, hash };
        prev = hash;
        return linked;
      });
    };
    expect(verify(link([at(1n, 0), at(2n, -CHAIN_CLOCK_SKEW_MS)])).valid).toBe(true);
    expect(verify(link([at(1n, 0), at(2n, -CHAIN_CLOCK_SKEW_MS - 1)])).brokenAt?.reason).toBe(
      'time_regression',
    );
  });

  it('reports an event dated in the future', () => {
    const now = new Date(Date.UTC(2026, 10, 12, 10, 0, 3));
    const verifier = new ChainVerifier(() => now);
    for (const e of chain(2)) verifier.push(e);
    expect(verifier.check().valid).toBe(true);
    const f = { ...fields(3n), occurredAt: new Date(now.getTime() + CHAIN_CLOCK_SKEW_MS + 1) };
    const prev = chain(2).at(-1)!.hash;
    verifier.push({ ...f, prevHash: prev, hash: eventHash(prev, f) });
    expect(verifier.check().brokenAt).toEqual({ seq: '3', reason: 'future_dated' });
  });
});
