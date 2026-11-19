import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreModule } from '../core.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditService } from './audit.service.js';
import { TsaClient } from '../transparency/evidence/tsa.client.js';
import { eventHash } from './chain.js';
import { REDACTED } from './sanitize.js';

describe('AuditService against PostgreSQL (M0-08)', () => {
  let prisma: PrismaService;
  let audit: AuditService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CoreModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records an event inside the domain transaction, without secrets', async () => {
    const targetId = randomUUID();
    await prisma.$transaction((tx) =>
      audit.record(tx, {
        actor: { type: 'user', id: 'carlos.dev-sub', entityId: randomUUID() },
        action: 'application.created',
        target: { type: 'application', id: targetId },
        after: { name: 'Validador', clientSecret: 'shown-once', createdAt: new Date(0) },
        requestId: 'req-1',
      }),
    );
    const { seq } = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId },
      orderBy: { seq: 'desc' },
    });

    const row = await prisma.auditEvent.findUniqueOrThrow({ where: { seq } });
    expect(row).toMatchObject({
      actorType: 'user',
      action: 'application.created',
      targetType: 'application',
      targetId,
      requestId: 'req-1',
      before: null,
      after: { name: 'Validador', clientSecret: REDACTED, createdAt: '1970-01-01T00:00:00.000Z' },
    });
  });

  it('rolls back with the transaction: no change, no event', async () => {
    const targetId = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record(tx, {
          actor: { type: 'system', id: 'test' },
          action: 'probe.created',
          target: { type: 'probe', id: targetId },
        });
        throw new Error('domain change failed');
      }),
    ).rejects.toThrow('domain change failed');
    expect(await prisma.auditEvent.count({ where: { targetId } })).toBe(0);
  });

  it('is append-only for the runtime role', async () => {
    const targetId = randomUUID();
    await prisma.$transaction((tx) =>
      audit.record(tx, {
        actor: { type: 'system', id: 'test' },
        action: 'probe.created',
        target: { type: 'probe', id: targetId },
      }),
    );
    const { seq } = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId },
      orderBy: { seq: 'desc' },
    });
    await expect(
      prisma.auditEvent.update({ where: { seq }, data: { action: 'probe.tampered' } }),
    ).rejects.toThrow(/permission denied/);
    await expect(prisma.auditEvent.delete({ where: { seq } })).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_event')).rejects.toThrow(
      /permission denied/,
    );
    expect(await prisma.auditEvent.count({ where: { targetId } })).toBe(1);
  });

  it('rejects malformed action names', async () => {
    await expect(
      prisma.$transaction((tx) =>
        audit.record(tx, {
          actor: { type: 'system', id: 'test' },
          action: 'Created',
          target: { type: 'probe', id: '1' },
        }),
      ),
    ).rejects.toThrow(/Invalid audit action/);
  });

  describe('hash chain (M1-11)', () => {
    const probe = async (targetId: string, after?: unknown): Promise<bigint> => {
      await prisma.$transaction((tx) =>
        audit.record(tx, {
          actor: { type: 'system', id: 'test' },
          action: 'probe.chained',
          target: { type: 'probe', id: targetId },
          after,
        }),
      );
      // The event of this call: the newest of its target.
      return (
        await prisma.auditEvent.findFirstOrThrow({
          where: { targetId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        })
      ).seq;
    };

    it('links each event to the previous one; the stored hash recomputes after jsonb', async () => {
      const targetId = randomUUID();
      // Key order, nested values, dates and NaN: jsonb must give back what was hashed.
      const first = await probe(targetId, {
        z: 1,
        a: { y: [1, 'b'], x: new Date(0) },
        n: Number.NaN,
      });
      const second = await probe(targetId, { status: 'approved' });
      const [a, b] = await prisma.auditEvent.findMany({
        where: { targetId },
        orderBy: { seq: 'asc' },
      });
      expect(b?.seq).toBeGreaterThan(first);
      expect(b?.seq).toBe(second);
      expect(a?.hash).toBe(eventHash(a?.prevHash ?? null, a!));
      expect(b?.hash).toBe(eventHash(b?.prevHash ?? null, b!));
      expect(a?.after).toEqual({
        z: 1,
        a: { y: [1, 'b'], x: '1970-01-01T00:00:00.000Z' },
        n: null,
      });
    });

    it('a rolled-back transaction leaves no gap in seq', async () => {
      const targetId = randomUUID();
      const before = await probe(targetId);
      await expect(
        prisma.$transaction(async (tx) => {
          await audit.record(tx, {
            actor: { type: 'system', id: 'test' },
            action: 'probe.rolled_back',
            target: { type: 'probe', id: targetId },
          });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const after = await probe(targetId);
      // Other suites may append meanwhile; what matters is that the chain stays contiguous.
      expect(after).toBeGreaterThan(before);
      expect((await new AuditQueryService(prisma, new TsaClient()).verify()).valid).toBe(true);
    });

    it('concurrent transactions append in order, contiguous and verifiable', async () => {
      const seqs = await Promise.all(
        Array.from({ length: 12 }, (_, i) => probe(randomUUID(), { i })),
      );
      expect(new Set(seqs).size).toBe(12);
      const check = await new AuditQueryService(prisma, new TsaClient()).verify();
      expect(check).toMatchObject({ valid: true });
      expect(check.verified).toBeGreaterThanOrEqual(12);
      expect(BigInt(check.lastSeq ?? '0')).toBeGreaterThanOrEqual(
        seqs.reduce((m, x) => (x > m ? x : m)),
      );
    });
  });

  describe('the table refuses what does not extend the chain (B-01)', () => {
    const insert = (values: {
      seq?: string;
      prevHash?: string | null;
      at?: string;
      hash?: string | null;
    }) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_event (seq, occurred_at, actor_type, actor_id, action, target_type, target_id, prev_hash, hash)
         VALUES ($1::bigint, $2::timestamptz, 'system', 'forger', 'probe.forged', 'probe', 'x', $3, $4)`,
        values.seq ?? '0',
        values.at ?? new Date().toISOString(),
        values.prevHash ?? null,
        values.hash === undefined ? 'a'.repeat(64) : values.hash,
      );

    it('rejects a row below the genesis, off the end, without hash, backdated or future-dated', async () => {
      const last = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: 'desc' } });
      const next = (last.seq + 1n).toString();
      await expect(insert({ seq: '0', hash: null })).rejects.toThrow();
      await expect(insert({ seq: '-1' })).rejects.toThrow();
      await expect(
        insert({ seq: (last.seq + 5n).toString(), prevHash: last.hash }),
      ).rejects.toThrow(/does not follow/);
      await expect(insert({ seq: next, prevHash: 'b'.repeat(64) })).rejects.toThrow(/prev_hash/);
      await expect(insert({ seq: next, prevHash: last.hash, hash: null })).rejects.toThrow();
      await expect(
        insert({ seq: next, prevHash: last.hash, at: '2020-01-01T00:00:00Z' }),
      ).rejects.toThrow(/goes back/);
      await expect(
        insert({
          seq: next,
          prevHash: last.hash,
          at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ).rejects.toThrow(/future/);
      expect(await prisma.auditEvent.count({ where: { action: 'probe.forged' } })).toBe(0);
    });
  });

  describe('the chain lock is held briefly (B-04)', () => {
    const record = (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0], id: string) =>
      audit.record(tx, {
        actor: { type: 'system', id: 'test' },
        action: 'probe.chained',
        target: { type: 'probe', id },
      });

    it('a long transaction with many events does not block other writers', async () => {
      const longId = randomUUID();
      const quickId = randomUUID();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let recorded: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        recorded = resolve;
      });
      const long = prisma.$transaction(
        async (tx) => {
          for (let i = 0; i < 25; i += 1) await record(tx, longId);
          recorded();
          await gate; // the rest of a long unit of work: external calls, many rows
        },
        { timeout: 30_000 },
      );
      await started;
      const t0 = Date.now();
      await prisma.$transaction((tx) => record(tx, quickId), { timeout: 5_000, maxWait: 5_000 });
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(await prisma.auditEvent.count({ where: { targetId: longId } })).toBe(0);
      release();
      await long;
      // The 25 events were appended together, contiguous, after the quick one.
      const events = await prisma.auditEvent.findMany({
        where: { targetId: { in: [longId, quickId] } },
        orderBy: { seq: 'asc' },
      });
      expect(events.filter((e) => e.targetId === longId)).toHaveLength(25);
      expect(events[0]?.targetId).toBe(quickId);
      expect((await new AuditQueryService(prisma, new TsaClient()).verify()).valid).toBe(true);
    });

    it('events of a transaction that rolls back are never written', async () => {
      const id = randomUUID();
      await expect(
        prisma.$transaction(async (tx) => {
          await record(tx, id);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await prisma.auditEvent.count({ where: { targetId: id } })).toBe(0);
    });

    it('concurrent long transactions all commit with a contiguous, verifiable chain', async () => {
      const ids = Array.from({ length: 6 }, () => randomUUID());
      await Promise.all(
        ids.map((id) =>
          prisma.$transaction(
            async (tx) => {
              for (let i = 0; i < 10; i += 1) await record(tx, id);
              await new Promise((r) => setTimeout(r, 300));
            },
            { timeout: 10_000, maxWait: 10_000 },
          ),
        ),
      );
      expect(await prisma.auditEvent.count({ where: { targetId: { in: ids } } })).toBe(60);
      expect((await new AuditQueryService(prisma, new TsaClient()).verify()).valid).toBe(true);
    });
  });
});
