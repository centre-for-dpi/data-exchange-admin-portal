import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { withAuditBuffer } from '../audit/audit-buffer.js';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

/** Client handed to code running inside `prisma.$transaction(async (tx) => ...)`. */
export type Tx = Prisma.TransactionClient;

/**
 * Prisma client for the runtime role (DATABASE_URL = den_app: no DDL, append-only audit).
 * Migrations use DATABASE_MIGRATION_URL through prisma.config.ts, never this client.
 * Connects lazily on the first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
    // Interactive transactions append their audit events at the end (B-04, audit-buffer.ts).
    const transaction = this.$transaction.bind(this) as (...args: unknown[]) => unknown;
    this.$transaction = ((first: unknown, ...rest: unknown[]) =>
      typeof first === 'function'
        ? transaction(
            (tx: Tx) => withAuditBuffer(first as (tx: Tx) => Promise<unknown>, tx),
            ...rest,
          )
        : transaction(first, ...rest)) as typeof this.$transaction;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
