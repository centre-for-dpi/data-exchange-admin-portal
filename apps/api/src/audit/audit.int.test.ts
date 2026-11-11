import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreModule } from '../core.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';
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
    const seq = await prisma.$transaction((tx) =>
      audit.record(tx, {
        actor: { type: 'user', id: 'carlos.dev-sub', entityId: randomUUID() },
        action: 'application.created',
        target: { type: 'application', id: targetId },
        after: { name: 'Validador', clientSecret: 'shown-once', createdAt: new Date(0) },
        requestId: 'req-1',
      }),
    );

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
    const seq = await prisma.$transaction((tx) =>
      audit.record(tx, {
        actor: { type: 'system', id: 'test' },
        action: 'probe.created',
        target: { type: 'probe', id: targetId },
      }),
    );
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
});
