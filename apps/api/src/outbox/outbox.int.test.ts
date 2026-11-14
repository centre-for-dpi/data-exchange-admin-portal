import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreModule } from '../core.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { OutboxService } from './outbox.service.js';

describe('outbox -> pg-boss relay against PostgreSQL (M0-08)', () => {
  let prisma: PrismaService;
  let outbox: OutboxService;
  let queue: QueueService;
  // A topic per run keeps runs independent in the shared test database.
  const topic = `test.run_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CoreModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    outbox = moduleRef.get(OutboxService);
    queue = moduleRef.get(QueueService);
    await queue.start();
    // Other suites leave unrelayed messages in the shared test database (RID_WORKER=off), and
    // the relay takes the oldest first: drain them so this run's messages are in the next batch.
    for (let i = 0; i < 1000 && (await queue.relayOnce()) > 0; i++);
  });
  afterAll(async () => {
    await queue.onApplicationShutdown();
    await prisma.$disconnect();
  });

  const pendingFor = (aggregate: string) =>
    prisma.outboxMessage.findMany({ where: { topic, aggregate } });

  it('writes the message in the domain transaction and drops it on rollback', async () => {
    const aggregate = `apiVersion:${randomUUID()}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, { topic, aggregate });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await pendingFor(aggregate)).toEqual([]);
  });

  it('relays committed messages to a queue job and marks them published', async () => {
    const aggregate = `apiVersion:${randomUUID()}`;
    const id = await prisma.$transaction((tx) =>
      outbox.enqueue(tx, { topic, aggregate, payload: { reason: 'published' } }),
    );

    await queue.relayOnce();

    const [message] = await pendingFor(aggregate);
    expect(message?.id).toBe(id);
    expect(message?.publishedAt).toBeInstanceOf(Date);
    expect(message?.attempts).toBe(1);

    const jobs = await queue.instance.fetch<{
      aggregate: string;
      outboxId: string;
      reason: string;
    }>(topic);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ aggregate, outboxId: id, reason: 'published' });
    await queue.instance.complete(topic, jobs[0]?.id ?? '');
  });

  it('coalesces several changes to the same aggregate into one queued job', async () => {
    const aggregate = `subscription:${randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await prisma.$transaction((tx) => outbox.enqueue(tx, { topic, aggregate }));
    }

    await queue.relayOnce();

    const messages = await pendingFor(aggregate);
    expect(messages.every((m) => m.publishedAt !== null)).toBe(true);
    const jobs = await queue.instance.fetch(topic, { batchSize: 10 });
    expect(
      jobs.filter((j) => (j.data as { aggregate: string }).aggregate === aggregate),
    ).toHaveLength(1);
    for (const job of jobs) await queue.instance.complete(topic, job.id);
  });

  it('rejects malformed topics', async () => {
    await expect(
      prisma.$transaction((tx) => outbox.enqueue(tx, { topic: 'Gateway Sync', aggregate: 'x' })),
    ).rejects.toThrow(/Invalid outbox topic/);
  });
});
